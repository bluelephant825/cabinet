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

test("the side-panel toggle restores a running conversation after focus closes it", () => {
  resetTaskPanel();
  const runningConversation = { ...conversation, status: "running" as const };
  useAppStore.getState().setTaskPanelConversation(runningConversation);
  useAppStore.getState().closeTaskPanel();
  useAppStore.getState().toggleTaskPanelCompose({ source: "editor", pinnedPagePath: "notes.md" });

  assert.equal(useAppStore.getState().taskPanelOpen, true);
  assert.equal(useAppStore.getState().taskPanelConversation, runningConversation);
  assert.equal(useAppStore.getState().taskPanelMode, "conversation");

  useAppStore.getState().toggleTaskPanelCompose();
  assert.equal(useAppStore.getState().taskPanelOpen, false);
  assert.equal(useAppStore.getState().taskPanelConversation, runningConversation);
});

test("the side-panel toggle preserves an existing compose context", () => {
  resetTaskPanel();
  useAppStore.getState().openTaskPanelCompose({ source: "editor", pinnedPagePath: "original.md" });
  const context = useAppStore.getState().taskPanelComposeContext;
  useAppStore.getState().closeTaskPanel();
  useAppStore.getState().toggleTaskPanelCompose({ source: "editor", pinnedPagePath: "other.md" });

  assert.equal(useAppStore.getState().taskPanelComposeContext, context);
  assert.equal(useAppStore.getState().taskPanelMode, "compose");
});

test("the first side-panel toggle initializes the compose context", () => {
  resetTaskPanel();
  useAppStore.getState().toggleTaskPanelCompose({ source: "editor", pinnedPagePath: "notes.md" });

  assert.equal(useAppStore.getState().taskPanelOpen, true);
  assert.equal(useAppStore.getState().taskPanelComposeContext?.pinnedPagePath, "notes.md");
});

test("a conversation created while the drawer is closed is retained without reopening it", () => {
  resetTaskPanel();
  useAppStore.getState().openTaskPanelCompose({ source: "editor", pinnedPagePath: "notes.md" });
  useAppStore.getState().closeTaskPanel();
  useAppStore.getState().swapToConversation(conversation);

  assert.equal(useAppStore.getState().taskPanelOpen, false);
  assert.equal(useAppStore.getState().taskPanelConversation, conversation);
  assert.equal(useAppStore.getState().taskPanelMode, "conversation");

  useAppStore.getState().toggleTaskPanelCompose();
  assert.equal(useAppStore.getState().taskPanelConversation, conversation);
  assert.equal(useAppStore.getState().taskPanelOpen, true);
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
