/**
 * Drives the Microsoft device-code sign-in from Cabinet's own backend, so the
 * connect panel can authenticate a *personal* Microsoft account before any
 * agent runs — instead of deferring login to first agent use.
 *
 * We don't reimplement OAuth: we spawn the same server's one-shot login command
 * (`@softeria/ms-365-mcp-server --login`), which performs the device-code flow
 * and caches the token where the MCP server reads it later. We parse the
 * device-code URL + code from its output, hand them to the UI, and let the
 * process keep polling Microsoft in the background until the user finishes.
 *
 * Personal flow only: no Entra credentials are passed, so the server uses its
 * built-in public-client app. Work/school accounts paste their own app and use
 * the deferred (first-use) login instead.
 *
 * The session registry is stashed on globalThis so it survives Next.js HMR in
 * dev. This is a local, single-instance feature — no cross-process store needed.
 */

import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";

export type LoginStatus = "pending" | "success" | "error" | "expired";

interface LoginSession {
  id: string;
  proc: ChildProcess;
  status: LoginStatus;
  verificationUri?: string;
  userCode?: string;
  error?: string;
  startedAt: number;
  /** When the session reached a terminal state (success/error/expired). */
  finishedAt?: number;
  /** Removal timer scheduled once terminal, so the Map can't grow unbounded. */
  cleanupTimer?: ReturnType<typeof setTimeout>;
  output: string;
}

const g = globalThis as unknown as {
  __msLoginSessions?: Map<string, LoginSession>;
};
const sessions = (g.__msLoginSessions ??= new Map<string, LoginSession>());

/** Device codes are valid ~15 min; expire the session a touch after that. */
const DEVICE_CODE_TIMEOUT_MS = 16 * 60 * 1000;
/** Allow first-run `npx` download + the code to be printed. */
const CODE_WAIT_MS = 120_000;
/** Keep a finished session around briefly so the client can read the final
 *  status, then drop it so the Map doesn't leak on a long-running server. */
const COMPLETED_TTL_MS = 5 * 60 * 1000;

/**
 * Move a session to a terminal state (idempotent — keeps the first terminal
 * status) and schedule its removal from the Map after a short grace period.
 */
function markTerminal(
  session: LoginSession,
  status: Exclude<LoginStatus, "pending">,
): void {
  if (session.status === "pending") session.status = status;
  if (session.finishedAt == null) session.finishedAt = Date.now();
  if (!session.cleanupTimer) {
    session.cleanupTimer = setTimeout(() => sessions.delete(session.id), COMPLETED_TTL_MS);
    session.cleanupTimer.unref?.();
  }
}

/**
 * Defense-in-depth reaper (also covers cleanup timers lost across an HMR
 * reload): drop finished sessions past their grace window and kill+drop any
 * pending session orphaned well beyond the device-code lifetime.
 */
function sweepSessions(): void {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (s.status !== "pending") {
      if (s.finishedAt != null && now - s.finishedAt > COMPLETED_TTL_MS) {
        sessions.delete(sid);
      }
    } else if (now - s.startedAt > DEVICE_CODE_TIMEOUT_MS + COMPLETED_TTL_MS) {
      try {
        s.proc.kill();
      } catch {
        /* already gone */
      }
      sessions.delete(sid);
    }
  }
}

// Device-code message, e.g.:
//   "...open the page https://login.microsoft.com/device and enter the code LF25UZJJQ to authenticate."
// The verification URL host/path varies (login.microsoft.com/device,
// microsoft.com/devicelogin, login.microsoftonline.com/...), so match any
// Microsoft URL in the message rather than a fixed path.
const URL_RE = /(https?:\/\/\S*microsoft\S*)/i;
const CODE_RE = /enter the code\s+([A-Z0-9-]{6,})|code[:\s]+([A-Z0-9-]{6,})/i;
const SUCCESS_RE = /login successful|logged in|authentication (?:successful|complete)/i;

function parseDeviceCode(text: string): { uri?: string; code?: string } {
  const uri = URL_RE.exec(text)?.[1];
  const m = CODE_RE.exec(text);
  const code = m?.[1] ?? m?.[2];
  return { uri, code };
}

export function getLoginStatus(sessionId: string): {
  status: LoginStatus;
  verificationUri?: string;
  userCode?: string;
  error?: string;
} | null {
  const s = sessions.get(sessionId);
  if (!s) return null;
  if (s.status === "pending" && Date.now() - s.startedAt > DEVICE_CODE_TIMEOUT_MS) {
    try {
      s.proc.kill();
    } catch {
      /* already gone */
    }
    markTerminal(s, "expired");
  }
  return {
    status: s.status,
    verificationUri: s.verificationUri,
    userCode: s.userCode,
    error: s.error,
  };
}

export function cancelLogin(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  if (s.cleanupTimer) clearTimeout(s.cleanupTimer);
  try {
    s.proc.kill();
  } catch {
    /* already gone */
  }
  sessions.delete(sessionId);
  return true;
}

/**
 * Spawn the device-code login and resolve once the URL + code are available.
 * The child keeps running (polling Microsoft) afterwards; poll `getLoginStatus`
 * to learn when the user has finished.
 */
export function startDeviceLogin(): Promise<{
  sessionId: string;
  verificationUri: string;
  userCode: string;
}> {
  sweepSessions(); // reap finished/orphaned sessions before adding a new one
  const id = randomUUID();
  const proc = spawn("npx", ["-y", "@softeria/ms-365-mcp-server", "--login"], {
    env: process.env, // no MS365_MCP_* → built-in public-client app (personal)
    stdio: ["ignore", "pipe", "pipe"],
  });
  const session: LoginSession = {
    id,
    proc,
    status: "pending",
    startedAt: Date.now(),
    output: "",
  };
  sessions.set(id, session);

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (message: string) => {
      if (!session.error) session.error = message;
      markTerminal(session, "error"); // won't clobber an already-recorded success
      if (!settled) {
        settled = true;
        try {
          proc.kill();
        } catch {
          /* already gone */
        }
        reject(new Error(message));
      }
    };

    const onData = (buf: Buffer) => {
      session.output += buf.toString();
      if (!session.verificationUri || !session.userCode) {
        const { uri, code } = parseDeviceCode(session.output);
        if (uri) session.verificationUri = uri;
        if (code) session.userCode = code;
        if (!settled && session.verificationUri && session.userCode) {
          settled = true;
          resolve({
            sessionId: id,
            verificationUri: session.verificationUri,
            userCode: session.userCode,
          });
        }
      }
      if (SUCCESS_RE.test(session.output)) markTerminal(session, "success");
    };

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);

    proc.on("error", (err) => fail(err.message));
    proc.on("exit", (code) => {
      if (session.status === "success" || code === 0) {
        markTerminal(session, "success");
      } else {
        session.error ??= `Sign-in process exited with code ${code}`;
        markTerminal(session, "error");
      }
      // Exited before ever emitting a device code → the start call failed.
      if (!settled) fail(session.error ?? "Sign-in ended before a code was issued");
    });

    setTimeout(() => {
      if (!settled) fail("Timed out waiting for the Microsoft device code");
    }, CODE_WAIT_MS);
  });
}
