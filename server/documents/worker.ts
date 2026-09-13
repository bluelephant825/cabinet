/**
 * Document worker child process. Protocol: JSON lines on stdio.
 *   request : { id, op, args }
 *   reply   : { id, ok: true, result } | { id, ok: false, error: { code, message, details? } }
 * Bytes never cross this channel — args carry inputPath/outputPath temp files
 * owned by the broker.
 */
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { DocumentError, asDocumentError } from "../../src/lib/documents/errors";

// Lazy: importing this module for `workerEntry()` (broker/daemon side) must
// not drag the vendored engines into the host process.
type RunOp = (op: string, args: Record<string, unknown>) => Promise<unknown>;
let runOpPromise: Promise<RunOp> | null = null;
function runOpLoader(): Promise<RunOp> {
  return (runOpPromise ??= import("./worker-ops").then((m) => m.runOp));
}

/**
 * Entry file the broker forks. In dev this .ts file is launched under `tsx`
 * (same as the daemon); a packaged build can set CABINET_DOC_WORKER_ENTRY to a
 * bundled .js file (Step 8).
 */
export function workerEntry(): string {
  return (
    process.env.CABINET_DOC_WORKER_ENTRY ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "worker.ts")
  );
}

interface WorkerRequest {
  id: number | string;
  op: string;
  args: Record<string, unknown>;
}

export function workerMain(): void {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    void handleLine(trimmed);
  });
}

async function handleLine(line: string): Promise<void> {
  let req: WorkerRequest;
  try {
    req = JSON.parse(line) as WorkerRequest;
  } catch {
    send({ id: -1, ok: false, error: { code: "invalid", message: "Malformed request line" } });
    return;
  }
  try {
    const runOp = await runOpLoader();
    const result = await runOp(req.op, req.args ?? {});
    send({ id: req.id, ok: true, result });
  } catch (err) {
    const e = asDocumentError(err, "worker-failed");
    send({
      id: req.id,
      ok: false,
      error: { code: e.code, message: e.message, details: e.details },
    });
  }
}

function send(msg: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (process.env.CABINET_DOC_WORKER === "1" || isEntrypoint) {
  workerMain();
}

export { DocumentError };
