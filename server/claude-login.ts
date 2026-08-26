// Cloud Claude Code login orchestration (CABINET_CLOUD): drive `claude setup-token` through a
// real PTY, capture the OAuth URL, submit the pasted code, capture the long-lived sk-ant-oat
// token, and persist it. Ported from the cabinet-cloud (Hila Version) cloud-daemon /auth/claude
// flow — but here the daemon runs INSIDE the tenant container, so node-pty gives us the real PTY
// directly (no docker-exec + expect script). The daemon then sets CLAUDE_CODE_OAUTH_TOKEN in its
// own env so agent CLIs it spawns are authenticated immediately (no restart), and writes the token
// to the tenant volume so it survives restarts.
import * as pty from "node-pty";
import { stripAnsi } from "./pty/ansi";
import { writeFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

const DATA = process.env.CABINET_DATA_DIR || "/data";
const TOKEN_PATH = path.join(DATA, ".claude-config", ".oauth-token");

// The URL claude setup-token prints, and the long-lived token it emits after the code.
const URL_RE = /https:\/\/(?:console\.anthropic\.com|claude\.(?:ai|com))\/[^\s\x1b"'`]+/;
const TOKEN_RE = /sk-ant-oat[A-Za-z0-9_-]+/;
const START_TIMEOUT_MS = 30_000;
const CODE_TIMEOUT_MS = 30_000;

type Session = { term: pty.IPty; buf: string; url?: string };
let session: Session | null = null; // single tenant per container → one login at a time

function kill() {
  if (session) { try { session.term.kill(); } catch {} session = null; }
}

/** Phase 1: spawn `claude setup-token`, resolve with the OAuth URL to show the user. */
export function claudeStart(): Promise<{ url: string }> {
  kill();
  return new Promise((resolve, reject) => {
    // Wide PTY so the OAuth URL never soft-wraps (the Hila Version's cols 400 trick).
    const term = pty.spawn("claude", ["setup-token"], {
      name: "xterm-256color", cols: 400, rows: 50, cwd: DATA,
      env: { ...process.env, TERM: "xterm-256color", COLUMNS: "400" },
    });
    const s: Session = { term, buf: "" };
    session = s;
    const timer = setTimeout(() => { reject(new Error("timed out waiting for the Claude login URL")); kill(); }, START_TIMEOUT_MS);
    term.onData((d) => {
      s.buf += stripAnsi(d);
      if (!s.url) {
        const m = s.buf.match(URL_RE);
        if (m) { s.url = m[0]; clearTimeout(timer); resolve({ url: s.url }); }
      }
    });
    term.onExit(() => { clearTimeout(timer); if (session === s) session = null; });
  });
}

/** Phase 2: submit the code, capture + persist the token. */
export function claudeCode(code: string): Promise<{ ok: true }> {
  const s = session;
  if (!s) return Promise.reject(new Error("no Claude login in progress — start again"));
  return new Promise((resolve, reject) => {
    // Ink TUI paste quirk: a bulk `code\r` is treated as a paste and never submits. Send the
    // code, then a discrete Enter (twice, spaced) so Ink sees a real keypress.
    s.term.write(code.trim());
    setTimeout(() => { try { s.term.write("\r"); } catch {} }, 800);
    setTimeout(() => { try { s.term.write("\r"); } catch {} }, 1600);
    const deadline = setTimeout(() => { reject(new Error("timed out waiting for the token — check the code")); }, CODE_TIMEOUT_MS);
    const poll = setInterval(async () => {
      const m = s.buf.match(TOKEN_RE);
      const lower = s.buf.toLowerCase();
      if (m) {
        clearInterval(poll); clearTimeout(deadline);
        await persist(m[0]);
        kill();
        resolve({ ok: true });
      } else if (/invalid|expired|error|failed/.test(lower) && lower.length > (s.url?.length ?? 0) + 40) {
        clearInterval(poll); clearTimeout(deadline);
        kill();
        reject(new Error("Claude rejected the code — start again"));
      }
    }, 300);
  });
}

async function persist(token: string): Promise<void> {
  await mkdir(path.dirname(TOKEN_PATH), { recursive: true, mode: 0o700 });
  await writeFile(TOKEN_PATH, token, { mode: 0o600 });
  // Immediately available to agent CLIs the daemon spawns (they inherit this env).
  process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
}

/** Is Claude connected? (persisted token, or already in the daemon env / a live login.) */
export async function claudeStatus(): Promise<{ connected: boolean; pending: boolean }> {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return { connected: true, pending: !!session };
  try {
    const t = (await readFile(TOKEN_PATH, "utf8")).trim();
    if (t.startsWith("sk-ant-oat")) { process.env.CLAUDE_CODE_OAUTH_TOKEN = t; return { connected: true, pending: false }; }
  } catch {}
  return { connected: false, pending: !!session };
}

export async function claudeClear(): Promise<{ ok: true }> {
  kill();
  await rm(TOKEN_PATH, { force: true });
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  return { ok: true };
}
