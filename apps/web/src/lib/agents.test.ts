// apps/web/src/lib/agents.test.ts
import assert from "node:assert";
import { describe, it } from "node:test";
import { answeredCount, participantAccent, statusLabel, turnSentence, type AgentTurnResult } from "./agents.js";

const okTurn: AgentTurnResult = {
  agent: "image",
  ok: true,
  backend: { kind: "project_worker", provider: "kaggle", model: "Qwen/Qwen3-1.7B", endpointHost: "x.ngrok.app" },
  latencyMs: 1200,
  reply: "The scar reads as painted, so I restyled the cheek.",
  outgoing: 2,
  applied: [{ op: "update_character", ok: true, entity: "character", ref: "character:Kai", id: "c1", summary: "Updated character \"Kai\"" }],
  rejected: [],
  error: null,
};

describe("statusLabel", () => {
  it("maps each real status to an honest tone", () => {
    assert.deepEqual(statusLabel("delivered"), { text: "delivered", tone: "ok" });
    assert.deepEqual(statusLabel("reported"), { text: "to director", tone: "muted" });
    assert.deepEqual(statusLabel("sent"), { text: "waiting", tone: "warn" });
    assert.deepEqual(statusLabel("failed"), { text: "delivery failed", tone: "bad" });
    assert.deepEqual(statusLabel("something-new"), { text: "something-new", tone: "muted" });
  });
});

describe("turnSentence", () => {
  it("summarizes what the agent really did", () => {
    const s = turnSentence(okTurn);
    assert.match(s, /Image AI answered the director/);
    assert.match(s, /messaged 2 peers/);
    assert.match(s, /applied 1 store change/);
    assert.match(s, /Qwen\/Qwen3-1\.7B/);
  });

  it("reports a turn that could not run instead of hiding it", () => {
    const s = turnSentence({ ...okTurn, ok: false, reply: null, outgoing: 0, applied: [], backend: null, error: "no Image AI worker is ONLINE" });
    assert.match(s, /Image AI did not run — no Image AI worker is ONLINE/);
  });

  it("counts a refused write without claiming it landed", () => {
    const s = turnSentence({
      ...okTurn,
      applied: [{ op: "update_scene", ok: false, entity: "scene", ref: null, id: null, summary: "failed", error: "no scene 4" }],
      rejected: ["delete_scene"],
    });
    assert.match(s, /1 write refused/);
    assert.match(s, /ignored: delete_scene/);
  });
});

describe("answeredCount", () => {
  it("counts only the agents that actually answered", () => {
    assert.equal(answeredCount([okTurn, { ...okTurn, agent: "voice", ok: false }]), 1);
    assert.equal(answeredCount([]), 0);
  });
});

describe("participantAccent", () => {
  it("gives the director and each agent a distinct accent", () => {
    assert.equal(participantAccent("director"), "text-white");
    assert.notEqual(participantAccent("script"), participantAccent("image"));
  });
});
