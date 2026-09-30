// packages/shared/src/agent/agents.test.ts
import assert from "node:assert";
import { describe, it } from "node:test";
import {
  AGENT_CHANNEL_ORDER,
  AGENT_ROSTER,
  agentLabel,
  agentProfile,
  buildAgentChannelPrompt,
  inboxFor,
  renderChannelTranscript,
  type ChannelMessage,
} from "./agents.js";
import { AGENT_ACTION_OPS, type AgentStoreSnapshot } from "./protocol.js";

const snapshot: AgentStoreSnapshot = {
  project: { id: "p1", slug: "crimson-ink", title: "Crimson Ink", logline: "A brush that paints fate.", story_bible: {} },
  characters: [{ name: "Kai", role: "protagonist", description: "Calligrapher" }],
  locations: [],
  episodes: [{ number: 1, title: "First Stroke", status: "writing", concept: null }],
  scenes: [{ episode_number: 1, index: 0, title: "Ink spills" }],
  taken_at: "2026-09-30T00:00:00.000Z",
};

const channel: ChannelMessage[] = [
  { from_agent: "director", to_agent: "script", kind: "brief", content: "Episode 1 — Kai finds the scar." },
  { from_agent: "script", to_agent: "image", kind: "request", content: "Give Kai a scar on the left cheek." },
];

describe("agent roster", () => {
  it("covers every channel role plus the overseer exactly once", () => {
    const kinds = AGENT_ROSTER.map((a) => a.kind).sort();
    assert.deepEqual(kinds, ["image", "overseer", "script", "voice"]);
    for (const kind of AGENT_CHANNEL_ORDER) assert.ok(AGENT_ROSTER.some((a) => a.kind === kind));
  });

  it("labels the human director and every agent", () => {
    assert.equal(agentLabel("director"), "Director");
    assert.equal(agentLabel("script"), "Script AI");
    assert.equal(agentLabel("overseer"), "Showrunner");
  });

  it("exposes a profile for each kind and throws on an unknown one", () => {
    assert.equal(agentProfile("image").workerType, "image");
    assert.throws(() => agentProfile("nope" as never));
  });

  it("carries no delete capability anywhere in the roster", () => {
    for (const a of AGENT_ROSTER) {
      for (const cap of [...a.capabilities, a.specialty]) assert.doesNotMatch(cap, /delete/);
    }
  });
});

describe("renderChannelTranscript", () => {
  it("renders each real message with its sender, recipient and kind", () => {
    const text = renderChannelTranscript(channel);
    assert.match(text, /\[Director → Script AI\] \(brief\) Episode 1 — Kai finds the scar\./);
    assert.match(text, /\[Script AI → Image AI\] \(request\) Give Kai a scar on the left cheek\./);
  });

  it("says the channel is empty rather than omitting it", () => {
    assert.match(renderChannelTranscript([]), /CHANNEL: \(empty/);
  });
});

describe("inboxFor", () => {
  it("keeps messages addressed to the agent, directly or to all, and never its own", () => {
    const rows: ChannelMessage[] = [
      { from_agent: "script", to_agent: "image", kind: "request", content: "scar" },
      { from_agent: "director", to_agent: "all", kind: "brief", content: "start" },
      { from_agent: "image", to_agent: "voice", kind: "handoff", content: "pace it" },
      { from_agent: "image", to_agent: "image", kind: "note", content: "self" },
    ];
    const inbox = inboxFor("image", rows);
    assert.deepEqual(inbox.map((m) => m.content), ["scar", "start"]);
  });
});

describe("buildAgentChannelPrompt", () => {
  it("teaches the peer-messages envelope and reuses the action allow-list", () => {
    const prompt = buildAgentChannelPrompt({ agent: "image", snapshot, messages: channel });
    assert.match(prompt, /EXACTLY ONE JSON object/);
    assert.match(prompt, /"messages"/);
    assert.match(prompt, /Image AI of Ostra Studio/);
    for (const op of AGENT_ACTION_OPS) assert.match(prompt, new RegExp(op));
    assert.match(prompt, /STORE CONTEXT/);
  });

  it("shows the agent its inbox and the channel", () => {
    const prompt = buildAgentChannelPrompt({ agent: "image", snapshot, messages: channel });
    assert.match(prompt, /YOUR INBOX \(addressed to Image AI\)/);
    assert.match(prompt, /Give Kai a scar on the left cheek\./);
    assert.match(prompt, /CHANNEL SO FAR/);
  });

  it("says the inbox is empty rather than hiding it", () => {
    const prompt = buildAgentChannelPrompt({ agent: "voice", snapshot, messages: channel });
    assert.match(prompt, /YOUR INBOX: \(nothing addressed to you/);
  });

  it("gives the overseer reporting rules instead of production rules", () => {
    const prompt = buildAgentChannelPrompt({ agent: "overseer", snapshot, messages: channel, overseer: true });
    assert.match(prompt, /Showrunner of Ostra Studio/);
    assert.match(prompt, /Report what each agent actually did/);
    assert.doesNotMatch(prompt, /Your peers are/);
  });
});
