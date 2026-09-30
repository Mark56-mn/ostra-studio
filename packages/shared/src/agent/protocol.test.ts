// packages/shared/src/agent/protocol.test.ts
import assert from "node:assert";
import { describe, it } from "node:test";
import {
  AGENT_ACTION_OPS,
  buildAgentSystemPrompt,
  combineReasoning,
  isAgentActionOp,
  parseAgentResponse,
  renderStoreContext,
  splitReasoning,
  type AgentStoreSnapshot,
} from "./protocol.js";

// The thinking tags are built from char codes on purpose: written literally they are indistinguishable
// from HTML and some file-writing paths drop them, which silently empties these tests.
const LT = String.fromCharCode(60);
const GT = String.fromCharCode(62);
const withThink = (reasoning: string, answer: string) => `${LT}think${GT}${reasoning}${LT}/think${GT}${answer}`;
const OPEN_THINK = `${LT}think${GT}`;

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

describe("thinking is separated from the answer", () => {
  it("splits Qwen3-style inline thinking off the JSON envelope", () => {
    const r = parseAgentResponse(
      withThink(
        "Kai needs a rival, so I will create Rin.",
        '{"reply":"Added Rin.","actions":[{"op":"create_character","data":{"name":"Rin"}}]}'
      )
    );
    assert.equal(r.reasoning, "Kai needs a rival, so I will create Rin.");
    assert.equal(r.parse, "json");
    assert.equal(r.reply, "Added Rin.");
    assert.deepEqual(r.actions, [{ op: "create_character", data: { name: "Rin" } }]);
  });

  it("keeps thinking out of a prose answer too", () => {
    const r = parseAgentResponse(withThink("Maybe the ink should bleed.", "The ink could bleed into the gutters."));
    assert.equal(r.parse, "text_fallback");
    assert.equal(r.reasoning, "Maybe the ink should bleed.");
    assert.equal(r.reply, "The ink could bleed into the gutters.");
  });

  it("does not let braces inside the thinking hijack the envelope", () => {
    const r = parseAgentResponse(
      withThink('Draft: {"reply":"wrong"} — discard that.', '{"reply":"Real.","actions":[]}')
    );
    assert.equal(r.reply, "Real.");
    assert.deepEqual(r.actions, []);
    assert.equal(r.reasoning, 'Draft: {"reply":"wrong"} — discard that.');
  });

  it("keeps an unterminated thought and reports an empty answer", () => {
    const r = parseAgentResponse(`${OPEN_THINK}I am still working out the arc and the budget ran out`);
    assert.equal(r.reasoning, "I am still working out the arc and the budget ran out");
    assert.equal(r.reply, "");
    assert.deepEqual(r.actions, []);
  });

  it("uses the backend's separate reasoning channel when it sends one", () => {
    const r = parseAgentResponse('{"reply":"Done.","actions":[]}', "Considered three options.");
    assert.equal(r.reasoning, "Considered three options.");
    assert.equal(r.reply, "Done.");
  });

  it("reads a reasoning key inside the JSON envelope (a server forced into JSON mode)", () => {
    const r = parseAgentResponse('{"reasoning":"Weighed two openings.","reply":"Done.","actions":[]}');
    assert.equal(r.reasoning, "Weighed two openings.");
    assert.equal(r.reply, "Done.");
    assert.deepEqual(r.actions, []);
  });

  it("reports no reasoning at all when the model did not think", () => {
    assert.equal(parseAgentResponse('{"reply":"Done.","actions":[]}').reasoning, "");
  });

  it("splitReasoning handles both tag spellings and is safe on empty input", () => {
    assert.deepEqual(splitReasoning(withThink("thinking hard", "the answer")), { reasoning: "thinking hard", answer: "the answer" });
    assert.deepEqual(splitReasoning(`${LT}thinking${GT}alt spelling${LT}/thinking${GT}answer`), {
      reasoning: "alt spelling",
      answer: "answer",
    });
    assert.deepEqual(splitReasoning(""), { reasoning: "", answer: "" });
    assert.deepEqual(splitReasoning("just an answer"), { reasoning: "", answer: "just an answer" });
    assert.equal(combineReasoning("", null), "");
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

  it("tells the model its reasoning is shown separately from the JSON answer", () => {
    assert.match(buildAgentSystemPrompt(snapshot), /reason as much as you need inside/);
  });

  it("adds the room note when one is set", () => {
    assert.match(buildAgentSystemPrompt(snapshot, "Keep it PG."), /DIRECTOR NOTE FOR THIS ROOM: Keep it PG\./);
    assert.doesNotMatch(buildAgentSystemPrompt(snapshot, null), /DIRECTOR NOTE/);
  });
});
