import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readSystemClipboard } from "./read-clipboard";

const ACCENTED = "La Norvège — résumé é è à ê";

test(
  "clipboard text survives a launchd-style C locale (macOS)",
  { skip: process.platform !== "darwin" },
  async () => {
    execFileSync("pbcopy", { input: ACCENTED });
    const saved = {
      LC_ALL: process.env.LC_ALL,
      LANG: process.env.LANG,
      LC_CTYPE: process.env.LC_CTYPE,
    };
    delete process.env.LC_ALL;
    delete process.env.LANG;
    delete process.env.LC_CTYPE;
    try {
      const text = await readSystemClipboard();
      assert.equal(text, ACCENTED);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);
