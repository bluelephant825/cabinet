import { test, expect } from "@playwright/test";

import { bootCabinet, type CabinetInstance } from "../test/support/harness";
import { claudeReply } from "../test/support/fake-agent-cli";
import { startConversation, waitForStatus } from "../test/support/cabinet-api";
import {
  buildBlankDocx,
  parseDocx,
  saveDocx,
  type SaveBlock,
} from "../src/vendor/genoffice/packages/docx-engine/src/index";

/**
 * Step 7: an agent edits a DOCX through `cabinet-documents` — the helper shim
 * on the spawned CLI's PATH, the agent-actor history attribution, and the
 * document:changed → frame reload path are all exercised for real.
 */

let cabinet: CabinetInstance;

const para = (text: string): SaveBlock => ({
  kind: "generated",
  block: { type: "paragraph", runs: [{ text }] },
});

async function makeDocx(...texts: string[]): Promise<Buffer> {
  const blank = await buildBlankDocx();
  const doc = await parseDocx(blank);
  return Buffer.from(await saveDocx(doc, texts.map(para)));
}

async function putDocument(pathname: string, bytes: Buffer) {
  const qs = new URLSearchParams({ path: pathname });
  return fetch(`${cabinet.appUrl}/api/documents/save?${qs}`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array(bytes),
  });
}

async function inspectDoc(pathname: string) {
  const res = await fetch(`${cabinet.appUrl}/api/documents/inspect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ virtualPath: pathname }),
  });
  return res.json() as Promise<{
    paragraphs: { id: string; text: string }[];
  }>;
}

async function revisionOf(pathname: string): Promise<string> {
  const res = await fetch(
    `${cabinet.appUrl}/api/documents/revision?path=${encodeURIComponent(pathname)}`,
  );
  return ((await res.json()) as { revision: string }).revision;
}

test.beforeAll(async () => {
  cabinet = await bootCabinet({ fakeAgents: [{ name: "claude" }] });
  const res = await putDocument(
    "agentdoc.docx",
    await makeDocx("Original paragraph text"),
  );
  expect(res.ok, `seed PUT failed: ${res.status} ${await res.text()}`).toBe(true);
});

test.afterAll(async () => {
  await cabinet?.close();
});

test("agent edits a docx via cabinet-documents; history + frame follow", async ({
  page,
}) => {
  // Open the DOCX editor clean so the agent's commit must reload the frame.
  await page.addInitScript(() => {
    window.localStorage.setItem("cabinet.dataDirConfirmed", "silent");
    window.localStorage.setItem("cabinet.wizard-done", "1");
    window.localStorage.setItem("cabinet.tour-done", "1");
  });
  await page.goto(`${cabinet.appUrl}/room/agentdoc.docx`);
  await page.getByRole("button", { name: "agentdoc", exact: true }).first().click();
  const frame = page.frameLocator('iframe[title="Document editor"]');
  await expect(frame.locator(".ProseMirror").first()).toBeVisible({
    timeout: 30_000,
  });
  const before = await revisionOf("agentdoc.docx");

  // Discover the paragraph id the same way an agent would: inspect first.
  const inspected = await inspectDoc("agentdoc.docx");
  const target = inspected.paragraphs.find((p) =>
    p.text.includes("Original paragraph text"),
  );
  expect(target).toBeTruthy();
  const ops = JSON.stringify([
    {
      kind: "replaceParagraphText",
      paragraphId: target!.id,
      expectedText: target!.text,
      newText: "Edited by the agent",
    },
  ]);

  // The fake CLI runs the helper exactly where a real CLI would: its PATH.
  await cabinet.agent("claude").reset([
    claudeReply("Updated the document.", {
      run: `cabinet-documents patch --path agentdoc.docx --ops '${ops}'`,
      cabinet: {
        summary: "edited docx",
        artifacts: ["agentdoc.docx"],
      },
    }),
  ]);

  const conversation = await startConversation(cabinet, {
    agentSlug: "editor",
    userMessage: "Update agentdoc.docx",
  });
  await waitForStatus(cabinet, conversation.id, "completed");

  // Spawn env carried the run identity.
  const [invocation] = await cabinet.agent("claude").waitForInvocations(1);
  expect(invocation.agentEnv.slug).toBe("editor");
  expect(invocation.agentEnv.runId).toBe(conversation.id);

  // The commit is real: revision advanced and the new text is in the file.
  const after = await revisionOf("agentdoc.docx");
  expect(after).not.toBe(before);
  const now = await inspectDoc("agentdoc.docx");
  expect(now.paragraphs.some((p) => p.text === "Edited by the agent")).toBe(true);

  // History attribution: the daemon recorded the mutation with an agent actor.
  await expect
    .poll(async () => {
      const res = await fetch(
        `${cabinet.appUrl}/api/history/file?path=agentdoc.docx`,
      );
      const body = (await res.json()) as {
        events?: { actor?: { kind?: string; slug?: string } }[];
      };
      return (body.events ?? [])
        .filter((e) => e.actor?.kind === "agent")
        .map((e) => e.actor!.slug);
    })
    .toContain("editor");

  // The open editor reloaded to the committed content (clean frame → reload,
  // not conflict).
  await expect(
    frame.locator(".ProseMirror").first(),
  ).toContainText("Edited by the agent", { timeout: 30_000 });
});
