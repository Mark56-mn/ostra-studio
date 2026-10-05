// packages/shared/src/agent/protocol.manager.test.ts
// The management envelope: instructions to peers and `start` requests. The parser only RECORDS what
// the model emitted — it never grants a start, and an unknown target is dropped, not invented.

import assert from "node:assert";
import { describe, it } from "node:test";
import { AGENT_MAX_STARTS, parseAgentResponse, resolveParticipant } from "./protocol";

describe("management envelope", () => {
  it("reads the start list the model asked for", () => {
    const r = parseAgentResponse(
      JSON.stringify({ reply: "Starting the script agent.", start: ["script", "image"], actions: [] })
    );
    assert.equal(r.parse, "json");
    assert.deepEqual(r.starts, ["script", "image"]);
  });

  it("accepts instructions addressed by the label the prompt uses", () => {
    const r = parseAgentResponse(
      JSON.stringify({
        reply: "Briefing the team.",
        messages: [
          { to: "Script AI", kind: "instruction", content: "Write episode 1." },
          { to: "overseer", kind: "instruction", content: "Check continuity." },
          { to: "Management Team", kind: "ack", content: "Heard." },
        ],
      })
    );
    assert.deepEqual(
      r.messages.map((m) => m.to),
      ["script", "overseer", "manager"]
    );
    assert.ok(r.messages.slice(0, 2).every((m) => m.kind === "instruction"));
  });

  it("resolves who an agent addressed, or nothing at all", () => {
    assert.equal(resolveParticipant("Script AI"), "script");
    assert.equal(resolveParticipant("showrunner"), "overseer");
    assert.equal(resolveParticipant("Management Team"), "manager");
    assert.equal(resolveParticipant("the intern"), null);
    assert.equal(resolveParticipant(42), null);
  });

  it("drops unknown start targets and duplicates instead of passing them on", () => {
    const r = parseAgentResponse(
      JSON.stringify({ reply: "ok", start: ["script", "script", "database", "drop table", {}] })
    );
    assert.deepEqual(r.starts, ["script"]);
  });

  it("never treats 'director' or a store op as a startable target", () => {
    const r = parseAgentResponse(JSON.stringify({ reply: "ok", start: ["director", "delete_episode"] }));
    assert.deepEqual(r.starts, []);
  });

  it("bounds how many starts one answer may request", () => {
    const many = Array.from({ length: 40 }, () => "script");
    const r = parseAgentResponse(JSON.stringify({ reply: "ok", start: many }));
    assert.ok(r.starts.length <= AGENT_MAX_STARTS);
    assert.deepEqual(r.starts, ["script"]); // duplicates collapse
  });

  it("accepts an envelope that only asks for a start", () => {
    const r = parseAgentResponse(JSON.stringify({ start: ["script"] }));
    assert.equal(r.parse, "json");
    assert.deepEqual(r.starts, ["script"]);
  });

  it("reports no starts at all for a prose answer", () => {
    const r = parseAgentResponse("I would start the script agent next.");
    assert.equal(r.parse, "text_fallback");
    assert.deepEqual(r.starts, []);
  });
});