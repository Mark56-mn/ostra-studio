// apps/web/src/lib/chat.test.ts
import assert from "node:assert";
import { describe, it } from "node:test";
import {
  actionLabel,
  actionTone,
  backendLabel,
  formatClock,
  mergeMessages,
  reasoningWords,
  type AppliedAction,
  type ChatMessage,
} from "./chat.js";

function message(id: string, createdAt: string, content = id, role: "user" | "assistant" = "assistant"): ChatMessage {
  return {
    id,
    room_id: "r1",
    role,
    content,
    reasoning: null,
    actions: [],
    backend: null,
    error: null,
    created_at: createdAt,
  };
}

describe("mergeMessages", () => {
  it("keeps one row per id and orders by created_at", () => {
    const existing = [message("b", "2026-09-29T10:00:02.000Z")];
    const incoming = [message("a", "2026-09-29T10:00:01.000Z"), message("b", "2026-09-29T10:00:02.000Z"), message("c", "2026-09-29T10:00:03.000Z")];
    const merged = mergeMessages(existing, incoming);
    assert.deepEqual(merged.map((m) => m.id), ["a", "b", "c"]);
  });

  it("lets the newest server state replace a stale row", () => {
    const existing = [{ ...message("a", "2026-09-29T10:00:01.000Z", "sending…") }];
    const incoming = [{ ...message("a", "2026-09-29T10:00:01.000Z", "the real answer") }];
    assert.equal(mergeMessages(existing, incoming)[0].content, "the real answer");
  });

  it("carries the model's reasoning through a merge", () => {
    const incoming = [{ ...message("a", "2026-09-29T10:00:01.000Z"), reasoning: "I weighed two options." }];
    assert.equal(mergeMessages([], incoming)[0].reasoning, "I weighed two options.");
  });

  it("is stable when timestamps are equal or unparseable", () => {
    const merged = mergeMessages([], [message("z", "not-a-date"), message("y", "not-a-date")]);
    assert.deepEqual(merged.map((m) => m.id), ["y", "z"]);
  });
});

describe("action presentation", () => {
  const created: AppliedAction = {
    op: "create_character",
    ok: true,
    entity: "character",
    ref: "character:Kai",
    id: "c1",
    summary: 'Created character "Kai"',
  };
  const failed: AppliedAction = {
    op: "update_episode",
    ok: false,
    entity: "episode",
    ref: null,
    id: null,
    summary: "update_episode failed",
    error: "no EP 7 in Crimson Ink",
  };

  it("shows the real summary for an applied action", () => {
    assert.equal(actionLabel(created), 'Created character "Kai"');
    assert.equal(actionTone(created), "ok");
  });

  it("never hides a failed write", () => {
    assert.match(actionLabel(failed), /no EP 7 in Crimson Ink/);
    assert.equal(actionTone(failed), "bad");
  });

  it("falls back to a generic reason when the backend sent none", () => {
    assert.match(actionLabel({ ...failed, error: undefined }), /unknown error/);
  });
});

describe("backendLabel", () => {
  it("distinguishes the project runtime from a hosted fallback", () => {
    assert.equal(
      backendLabel({ kind: "project_worker", provider: "kaggle", model: "Qwen/Qwen3-1.7B", endpointHost: "x.ngrok.app" }),
      "Qwen/Qwen3-1.7B · project runtime"
    );
    assert.equal(
      backendLabel({ kind: "hosted_fallback", provider: "openai", model: "gpt-4o-mini", endpointHost: "api.openai.com" }),
      "gpt-4o-mini · hosted fallback"
    );
  });

  it("returns null when there was no backend", () => {
    assert.equal(backendLabel(null), null);
  });
});

describe("reasoningWords", () => {
  it("counts the words of a real reasoning trace", () => {
    assert.equal(reasoningWords("the ink should bleed into the gutters"), 7);
  });

  it("is zero when the model did not think", () => {
    assert.equal(reasoningWords(null), 0);
    assert.equal(reasoningWords(undefined), 0);
    assert.equal(reasoningWords("   \n  "), 0);
  });
});

describe("formatClock", () => {
  it("returns an empty string for an unparseable timestamp", () => {
    assert.equal(formatClock("nope"), "");
  });
});
