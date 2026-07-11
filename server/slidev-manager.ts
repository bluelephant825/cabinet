import { ChildProcess, spawn } from "child_process";
import net from "net";
import path from "path";

interface SlidevInstance {
  child: ChildProcess;
  port: number;
  url: string;
  filePath: string;
}

class SlidevManager {
  private instances = new Map<string, SlidevInstance>(); // filePath -> instance

  /**
   * Starts a Slidev server for the given markdown file.
   * If a server is already running for this file, returns the existing URL.
   */
  async start(filePath: string): Promise<string> {
    const absolutePath = path.resolve(filePath);
    const existing = this.instances.get(absolutePath);
    if (existing) {
      return existing.url;
    }

    const port = await this.getAvailablePort(3030);
    const url = `http://localhost:${port}`;

    console.log(`[Slidev] Starting Slidev server for ${absolutePath} on port ${port}...`);

    const isWin = process.platform === "win32";
    const child = spawn(isWin ? "npx.cmd" : "npx", [
      "@slidev/cli",
      absolutePath,
      "--port",
      port.toString(),
      "--no-open"
    ], {
      env: process.env,
      shell: isWin
    });

    const instance: SlidevInstance = { child, port, url, filePath: absolutePath };
    this.instances.set(absolutePath, instance);

    child.stdout?.on("data", (data) => {
      console.log(`[Slidev stdout] ${data.toString().trim()}`);
    });

    child.stderr?.on("data", (data) => {
      console.error(`[Slidev stderr] ${data.toString().trim()}`);
    });

    child.on("close", (code) => {
      console.log(`[Slidev] Server for ${absolutePath} exited with code ${code}`);
      this.instances.delete(absolutePath);
    });

    // Poll the port until it is listening, up to a timeout (e.g. 15 seconds)
    const isPortOpen = async (p: number): Promise<boolean> => {
      return new Promise((resolve) => {
        const client = new net.Socket();
        client.setTimeout(150);
        client.on("connect", () => {
          client.destroy();
          resolve(true);
        });
        client.on("timeout", () => {
          client.destroy();
          resolve(false);
        });
        client.on("error", () => {
          client.destroy();
          resolve(false);
        });
        client.connect(p, "127.0.0.1");
      });
    };

    const startTime = Date.now();
    let ready = false;
    while (Date.now() - startTime < 15000) { // 15 seconds max wait
      if (await isPortOpen(port)) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    if (!ready) {
      console.warn(`[Slidev] Port ${port} did not start listening within 15 seconds.`);
    }

    return url;
  }

  /**
   * Stops the Slidev server running for the given markdown file.
   */
  stop(filePath: string): boolean {
    const absolutePath = path.resolve(filePath);
    const instance = this.instances.get(absolutePath);
    if (instance) {
      console.log(`[Slidev] Stopping server for ${absolutePath}`);
      instance.child.kill("SIGTERM");
      this.instances.delete(absolutePath);
      return true;
    }
    return false;
  }

  /**
   * Helper to scan ports and find an available one.
   */
  private getAvailablePort(startPort: number): Promise<number> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.unref();
      server.on("error", () => {
        resolve(this.getAvailablePort(startPort + 1));
      });
      server.listen(startPort, () => {
        const port = (server.address() as net.AddressInfo).port;
        server.close(() => {
          resolve(port);
        });
      });
    });
  }

  /**
   * Shutdown all active Slidev processes (used when daemon stops).
   */
  shutdownAll() {
    for (const [path, instance] of this.instances.entries()) {
      console.log(`[Slidev] Killing server for ${path} during daemon shutdown`);
      try {
        instance.child.kill("SIGKILL");
      } catch (e) {
        console.error(`[Slidev] Error killing server for ${path}:`, e);
      }
    }
    this.instances.clear();
  }
}

export const slidevManager = new SlidevManager();
