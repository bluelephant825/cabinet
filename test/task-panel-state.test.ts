import test from "node:test";
import assert from "node:assert/strict";

import { useAppStore } from "@/stores/app-store";
import type { ConversationMeta } from "@/types/conversations";

const conversation: ConversationMeta = {
  id: "conv-1",
  agentSlug: "researcher",
  title: "Research task",
  trigger: "manual",
  status: "idle",
  startedAt: "2026-01-01T00:00:00.000Z",
  promptPath: ".agents/.conversations/conv-1/prompt.md",
  transcriptPath: ".agents/.conversations/conv-1/transcript.txt",
  mentionedPaths: [],
  artifactPaths: [],
};

function resetTaskPanel(): void {
  useAppStore.setState({
    taskPanelConversation: null,
    taskPanelOpen: false,
    taskPanelMode: "compose",
    taskPanelComposeContext: null,
    canvasSelectedCardPaths: [],
  });
}

test("reopenTaskPanel restores the conversation hidden by focus mode", () => {
  resetTaskPanel();
  useAppStore.getState().setTaskPanelConversation(conversation);
  useAppStore.getState().closeTaskPanel();

  assert.equal(useAppStore.getState().taskPanelOpen, false);
  assert.equal(useAppStore.getState().taskPanelConversation, conversation);
  assert.equal(useAppStore.getState().taskPanelMode, "conversation");

  useAppStore.getState().reopenTaskPanel();

  assert.equal(useAppStore.getState().taskPanelOpen, true);
  assert.equal(useAppStore.getState().taskPanelConversation, conversation);
  assert.equal(useAppStore.getState().taskPanelMode, "conversation");
});

test("clearTaskPanelChat leaves the current conversation and opens a blank composer", () => {
  resetTaskPanel();
  useAppStore.getState().setTaskPanelConversation(conversation);
  useAppStore.getState().clearTaskPanelChat();

  assert.equal(useAppStore.getState().taskPanelOpen, true);
  assert.equal(useAppStore.getState().taskPanelMode, "compose");
  assert.equal(useAppStore.getState().taskPanelConversation, null);
  assert.equal(useAppStore.getState().taskPanelComposeContext, null);
});
