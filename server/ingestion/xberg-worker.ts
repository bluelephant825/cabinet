import { spawn, execFile } from "node:child_process";
import path from "node:path";

export class XbergError extends Error {
  constructor(readonly code: "unavailable" | "timeout" | "output-limit" | "exit" | "protocol" | "aborted" | "busy", message: string) {
    super(message); this.name = "XbergError";
  }
}

/** An isolated extraction process is the worker. No shell, Electron renderer,
 * agent runtime, inherited provider credentials or imported configuration.
 */
export class XbergProcessWorker {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private closed = false;
  private cancel: (() => void) | null = null;

  constructor(private readonly options: { timeoutMs?: number; maxOutputBytes?: number; maxPending?: number } = {}) {
    for (const value of [options.timeoutMs ?? 120000, options.maxOutputBytes ?? 64 * 1024 * 1024, options.maxPending ?? 4]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid xberg worker limit");
    }
  }

  run(executable: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    if (this.closed) return Promise.reject(new XbergError("aborted", "Xberg worker is closed"));
    if (this.pending >= (this.options.maxPending ?? 4)) return Promise.reject(new XbergError("busy", "Xberg worker is busy"));
    this.pending++;
    const task = this.tail.then(() => {
      if (this.closed) throw new XbergError("aborted", "Xberg worker is closed");
      return this.execute(executable, args, cwd);
    }).finally(() => { this.pending--; });
    this.tail = task.catch(() => {});
    return task;
  }

  private execute(executable: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { NODE_ENV: "production", NO_COLOR: "1", HF_HUB_OFFLINE: "1" };
      for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG"]) {
        if (process.env[key]) env[key] = process.env[key];
      }
      if (env.PATH) env.PATH = env.PATH.split(path.delimiter).filter((item) => path.isAbsolute(item)).join(path.delimiter);
      const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true,
        detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      let failure: Error | null = null;
      const stop = (error: Error) => {
        if (failure) return;
        failure = error;
        if (!child.pid) return;
        if (process.platform === "win32") {
          const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
          execFile(taskkill, ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }, () => { child.kill("SIGKILL"); });
        } else {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
      };
      this.cancel = () => stop(new XbergError("aborted", "Xberg extraction cancelled"));
      const timer = setTimeout(() => stop(new XbergError("timeout", "Xberg extraction timed out")), this.options.timeoutMs ?? 120000);
      const collect = (chunks: Buffer[], chunk: Buffer) => {
        if (failure) return;
        size += chunk.length;
        if (size > (this.options.maxOutputBytes ?? 64 * 1024 * 1024)) stop(new XbergError("output-limit", "Xberg output exceeded its size limit"));
        else chunks.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => collect(out, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(err, chunk));
      child.once("error", () => { failure ??= new XbergError("unavailable", "Could not start xberg; check the executable and its runtime libraries"); });
      child.once("close", (code) => {
        clearTimeout(timer); this.cancel = null;
        if (failure) reject(failure);
        else if (code !== 0) reject(new XbergError("exit", `Xberg extraction failed (exit ${code}); the input may be unsupported or corrupt`));
        else {
          try {
            const decoder = new TextDecoder("utf-8", { fatal: true });
            resolve({ stdout: decoder.decode(Buffer.concat(out)), stderr: decoder.decode(Buffer.concat(err)) });
          } catch { reject(new XbergError("protocol", "Xberg returned invalid UTF-8")); }
        }
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true; this.cancel?.(); await this.tail;
  }
}
