// packages/shared/src/agent/protocol.test.ts
import assert from "node:assert";
import { describe, it } from "node:test";
import {
  AGENT_ACTION_OPS,
  buildAgentSystemPrompt,
  isAgentActionOp,
  parseAgentResponse,
  renderStoreContext,
  type AgentStoreSnapshot,
} from "./protocol.js";

describe("agent action allow-list", () => {
  it("is additive only — no delete operation is ever allowed", () => {
    for (const op of AGENT_ACTION_OPS) {
      assert.equal(op.startsWith("delete"), false, `${op} must not be allowed`);
    }
    assert.equal(isAgentActionOp("delete_project"), false);
    assert.equal(isAgentActionOp("create_character"), true);
  });
});

describe("parseAgentResponse", () => {
  it("reads the strict envelope", () => {
    const r = parseAgentResponse(
      '{"reply":"Kai now has a rival.","actions":[{"op":"create_character","data":{"name":"Rin","role":"rival"}}]}'
    );
    assert.equal(r.parse, "json");
    assert.equal(r.reply, "Kai now has a rival.");
    assert.deepEqual(r.actions, [{ op: "create_character", data: { name: "Rin", role: "rival" } }]);
    assert.deepEqual(r.rejected, []);
  });

  it("reads an envelope wrapped in a markdown fence", () => {
    const r = parseAgentResponse('Sure!\n```json\n{"reply":"Done.","actions":[]}\n```\n');
    assert.equal(r.parse, "json");
    assert.equal(r.reply, "Done.");
    assert.deepEqual(r.actions, []);
  });

  it("folds flattened arguments into data and keeps an explicit project handle", () => {
    const r = parseAgentResponse(
      '{"reply":"ok","actions":[{"op":"create_episode","project":"crimson-ink","title":"Episode 4","number":4}]}'
    );
    assert.deepEqual(r.actions, [
      { op: "create_episode", project: "crimson-ink", data: { title: "Episode 4", number: 4 } },
    ]);
  });

  it("accepts `action`/`arguments` aliases a small model may emit", () => {
    const r = parseAgentResponse('{"message":"ok","action":{"action":"create_location","arguments":{"name":"Docks"}}}');
    assert.equal(r.reply, "ok");
    assert.deepEqual(r.actions, [{ op: "create_location", data: { name: "Docks" } }]);
  });

  it("reports unknown and delete ops instead of applying them", () => {
    const r = parseAgentResponse('{"reply":"cleanup","actions":[{"op":"delete_scene","data":{"index":2}},{"op":"wipe"}]}');
    assert.deepEqual(r.actions, []);
    assert.deepEqual(r.rejected, ["delete_scene", "wipe"]);
  });

  it("drops non-primitive data values so they can never reach Postgres", () => {
    const r = parseAgentResponse('{"reply":"ok","actions":[{"op":"update_project","data":{"title":"Ink","story_bible":{"nested":true},"tags":["a"]}}]}');
    assert.deepEqual(r.actions, [{ op: "update_project", data: { title: "Ink" } }]);
  });

  it("falls back to prose without inventing actions", () => {
    const r = parseAgentResponse("I love that idea — the ink could bleed into the panel gutters.");
    assert.equal(r.parse, "text_fallback");
    assert.equal(r.reply, "I love that idea — the ink could bleed into the panel gutters.");
    assert.deepEqual(r.actions, []);
  });

  it("never throws on empty or malformed input", () => {
    for (const input of ["", "   ", "{", "null", "[]", undefined, null]) {
      const r = parseAgentResponse(input);
      assert.equal(typeof r.reply, "string");
      assert.deepEqual(r.actions, []);
    }
  });
});

const snapshot: AgentStoreSnapshot = {
  project: { id: "p1", slug: "crimson-ink", title: "Crimson Ink", logline: "A brush that paints fate.", story_bible: { premise: "Ink is memory." } },
  characters: [{ name: "Kai", role: "protagonist", description: "Calligrapher" }],
  locations: [{ name: "The Docks", description: null }],
  episodes: [{ number: 1, title: "First Stroke", status: "writing", concept: null }],
  scenes: [{ episode_number: 1, index: 0, title: "Ink spills" }],
  taken_at: "2026-09-29T00:00:00.000Z",
};

describe("renderStoreContext", () => {
  it("includes the real store rows and the read timestamp", () => {
    const text = renderStoreContext(snapshot);
    assert.match(text, /PROJECT: Crimson Ink \(slug: crimson-ink\)/);
    assert.match(text, /CHARACTERS: Kai \(protagonist\) — Calligrapher/);
    assert.match(text, /EPISODES: EP 1 "First Stroke" \[writing\]/);
    assert.match(text, /SCENES: EP 1 #0 "Ink spills"/);
    assert.match(text, /2026-09-29T00:00:00.000Z/);
  });

  it("says a section is empty rather than omitting it", () => {
    const text = renderStoreContext({ ...snapshot, characters: [], locations: [], scenes: [] });
    assert.match(text, /CHARACTERS: none/);
    assert.match(text, /LOCATIONS: none/);
    assert.match(text, /SCENES: none/);
  });

  it("reports an unreadable store instead of pretending it is empty", () => {
    assert.match(renderStoreContext(null), /STORE CONTEXT: unavailable/);
  });
});

describe("buildAgentSystemPrompt", () => {
  it("demands a single JSON object and lists every allowed op", () => {
    const prompt = buildAgentSystemPrompt(snapshot);
    assert.match(prompt, /EXACTLY ONE JSON object/);
    for (const op of AGENT_ACTION_OPS) assert.match(prompt, new RegExp(op));
    assert.match(prompt, /STORE CONTEXT/);
  });

  it("adds the room note when one is set", () => {
    assert.match(buildAgentSystemPrompt(snapshot, "Keep it PG."), /DIRECTOR NOTE FOR THIS ROOM: Keep it PG\./);
    assert.doesNotMatch(buildAgentSystemPrompt(snapshot, null), /DIRECTOR NOTE/);
  });
});
