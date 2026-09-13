/**
 * Shared async wrapper for the platform OCR helper binaries — the same
 * protocol upstream uses synchronously (PNG on stdin, JSON on stdout) but
 * driven asynchronously so the worker's event loop stays free between pages.
 * Helpers come from resources/documents/ocr/<platform>/ and are compiled by
 * scripts/build-ocr-helpers.mjs — never compiled or downloaded at runtime.
 */
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import type {
  OcrBounds,
  OcrLineResult,
  OcrRecognitionResult,
} from "../../../src/lib/documents/ocr-types";

/** A page render's JSON is a few hundred KB; 4 MB is generous headroom. */
export const HELPER_MAX_OUTPUT = 4 * 1024 * 1024;
export const HELPER_DEFAULT_TIMEOUT_MS = 30_000;

interface HelperChar {
  t: string;
  b: OcrBounds;
}
interface HelperLine {
  t: string;
  c: number;
  b: OcrBounds;
  chars?: HelperChar[];
}

/**
 * Run <helperPath> [languages] with `imagePath` streamed to stdin. Resolves
 * null on non-zero exit, malformed output, timeout, or oversize output —
 * callers treat null as "this page falls back to its bitmap".
 */
export function runOcrHelper(input: {
  helperPath: string;
  imagePath: string;
  languages?: string[];
  timeoutMs: number;
  engine: { id: string; version: string };
}): Promise<OcrRecognitionResult | null> {
  return new Promise((resolve) => {
    const args =
      input.languages && input.languages.length > 0 ? [input.languages.join(",")] : [];
    const child = spawn(input.helperPath, args, { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    let oversize = false;
    let done = false;
    const finish = (v: OcrRecognitionResult | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), input.timeoutMs);
    child.on("error", () => finish(null));
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.length > HELPER_MAX_OUTPUT) {
        oversize = true;
        finish(null);
      }
    });
    child.on("close", () => {
      if (done || oversize) return;
      clearTimeout(timer);
      done = true;
      try {
        // .NET consoles can prepend a UTF-8 BOM — strip it before parsing.
        const parsed = JSON.parse(out.replace(/^﻿/, "")) as {
          lines?: HelperLine[];
          paper?: number;
        };
        if (!Array.isArray(parsed.lines)) {
          resolve(null);
          return;
        }
        const lines: OcrLineResult[] = parsed.lines.map((l) => ({
          text: l.t,
          confidence: l.c,
          bounds: l.b,
          ...(l.chars
            ? { words: l.chars.map((c) => ({ text: c.t, confidence: l.c, bounds: c.b })) }
            : {}),
        }));
        resolve({
          lines,
          ...(typeof parsed.paper === "number" ? { paperShare: parsed.paper } : {}),
          engine: input.engine,
        });
      } catch {
        resolve(null);
      }
    });
    child.on("exit", (code) => {
      if (code !== 0) finish(null);
    });
    createReadStream(input.imagePath)
      .on("error", () => finish(null))
      .pipe(child.stdin!);
  });
}
