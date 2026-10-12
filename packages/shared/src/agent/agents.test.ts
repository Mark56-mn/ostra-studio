// packages/shared/src/agent/agents.test.ts
import assert from "node:assert";
import { describe, it } from "node:test";
import {
  AGENT_CHANNEL_ORDER,
  AGENT_ROSTER,
  DIRECT_CHAT_TARGETS,
  agentLabel,
  agentProfile,
  answerSourceLabel,
  buildAgentChannelPrompt,
  buildDirectChatPrompt,
  inboxFor,
  renderChannelTranscript,
  sharedModelNote,
  summarizeRound,
  type ChannelMessage,
  type RoundTurnLike,
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
  it("covers every channel role plus the overseer and the management team exactly once", () => {
    const kinds = AGENT_ROSTER.map((a) => a.kind).sort();
    assert.deepEqual(kinds, ["image", "manager", "overseer", "script", "voice"]);
    for (const kind of AGENT_CHANNEL_ORDER) assert.ok(AGENT_ROSTER.some((a) => a.kind === kind));
    // The management team directs; it is not one of the production agents of a round.
    assert.ok(!AGENT_CHANNEL_ORDER.includes("manager"));
  });

  it("labels the human director and every agent", () => {
    assert.equal(agentLabel("director"), "Director");
    assert.equal(agentLabel("script"), "Script AI");
    assert.equal(agentLabel("overseer"), "Showrunner");
    assert.equal(agentLabel("manager"), "Management Team");
  });

  it("tells the management team how to direct, and that a start is only a request", () => {
    const prompt = buildAgentChannelPrompt({
      agent: "manager",
      snapshot: null,
      messages: [],
      manager: true,
    });
    assert.match(prompt, /Management Team/);
    assert.match(prompt, /instruction/);
    assert.match(prompt, /"start"/);
    // The prompt may never promise the model that a start will happen.
    assert.doesNotMatch(prompt, /will start|guarantee/i);
  });

  it("addresses every agent by name in the envelope, including the manager", () => {
    const prompt = buildAgentChannelPrompt({ agent: "script", snapshot: null, messages: [] });
    assert.match(prompt, /Management Team/);
    assert.match(prompt, /Showrunner/);
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

  it("lists the new season ops in the channel prompt too", () => {
    const prompt = buildAgentChannelPrompt({ agent: "image", snapshot, messages: channel });
    assert.match(prompt, /create_season/);
    assert.match(prompt, /submit_season/);
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

describe("DIRECT_CHAT_TARGETS", () => {
  it("offers every canonical agent exactly once, in selection order", () => {
    assert.deepEqual(
      DIRECT_CHAT_TARGETS.map((t) => t.kind),
      ["manager", "script", "image", "voice", "overseer"]
    );
  });

  it("describes every target with a non-empty subtitle", () => {
    for (const target of DIRECT_CHAT_TARGETS) {
      assert.ok(target.subtitle.trim().length > 0, `${target.kind} has no subtitle`);
    }
  });
});

describe("answerSourceLabel", () => {
  it("names the real runtime that answered, never the roster default", () => {
    assert.equal(
      answerSourceLabel({ kind: "project_worker", provider: "kaggle", model: "Qwen/Qwen3-4B" }),
      "kaggle · project worker"
    );
    assert.equal(
      answerSourceLabel({ kind: "project_worker", provider: "kaggle", model: "Qwen/Qwen3-4B", workerType: "script" }),
      "kaggle · script worker"
    );
    assert.equal(
      answerSourceLabel({ kind: "hosted_nvidia", provider: "nvidia", model: "meta/llama-3.1-8b-instruct" }),
      "NVIDIA NIM · meta/llama-3.1-8b-instruct"
    );
    assert.equal(
      answerSourceLabel({ kind: "hosted_manager", provider: "openai", model: "gpt-4o-mini" }),
      "openai · management team"
    );
    assert.equal(
      answerSourceLabel({ kind: "hosted_fallback", provider: "openai", model: "gpt-4o-mini" }),
      "openai · hosted fallback"
    );
  });
});

describe("sharedModelNote", () => {
  it("admits when several roles share one hosted model", () => {
    assert.match(sharedModelNote({ kind: "hosted_nvidia", provider: "nvidia", model: "m" }) ?? "", /Shared hosted model/);
    assert.match(sharedModelNote({ kind: "hosted_manager", provider: "openai", model: "m" }) ?? "", /Shared hosted model/);
  });

  it("stays silent for a project worker, which is its own runtime", () => {
    assert.equal(sharedModelNote({ kind: "project_worker", provider: "kaggle", model: "m" }), null);
  });
});

describe("buildDirectChatPrompt", () => {
  it("frames a private one-to-one conversation and asks for the JSON envelope", () => {
    const prompt = buildDirectChatPrompt({ agent: "script", snapshot });
    assert.match(prompt, /PRIVATE conversation with the human director/);
    assert.match(prompt, /talking ONE-TO-ONE with the human director/);
    assert.match(prompt, /"reply"/);
    assert.match(prompt, /Put EVERY store change in `actions`/);
    assert.match(prompt, /STORE CONTEXT/);
    for (const op of AGENT_ACTION_OPS) assert.match(prompt, new RegExp(op));
  });

  it("names the peers a production agent may address", () => {
    const prompt = buildDirectChatPrompt({ agent: "voice", snapshot });
    assert.match(prompt, /Image AI/);
    assert.match(prompt, /Showrunner/);
  });

  it("carries the director note when the room has one, and omits it otherwise", () => {
    assert.match(
      buildDirectChatPrompt({ agent: "script", snapshot, directorNote: "Keep it PG." }),
      /DIRECTOR NOTE FOR THIS ROOM: Keep it PG\./
    );
    assert.doesNotMatch(buildDirectChatPrompt({ agent: "script", snapshot, directorNote: null }), /DIRECTOR NOTE/);
  });

  it("keeps the management team out of writing episodes itself", () => {
    const prompt = buildDirectChatPrompt({ agent: "manager", snapshot });
    assert.match(prompt, /you do not write the episodes yourself/);
    assert.match(prompt, /never claim an agent did work you have not seen come back/);
    assert.match(prompt, /`messages`/);
  });

  it("tells the Showrunner to report instead of producing", () => {
    const prompt = buildDirectChatPrompt({ agent: "overseer", snapshot });
    assert.match(prompt, /do NOT write story, art or audio yourself/);
    assert.doesNotMatch(prompt, /talking ONE-TO-ONE/);
  });
});

describe("summarizeRound", () => {
  const completed: RoundTurnLike = {
    agent: "script",
    ok: true,
    backend: { kind: "hosted_nvidia", provider: "nvidia", model: "meta/llama-3.1-70b-instruct" },
    reply: "Episode 1 drafted.",
    outgoing: 1,
    applied: [{ op: "create_episode", ok: true, ref: null }],
    error: null,
  };

  it("calls a stage that produced real output completed", () => {
    const { outcome, stages } = summarizeRound([completed]);
    assert.equal(outcome, "completed");
    assert.equal(stages[0].outcome, "completed");
  });

  it("does not confuse a backend with the completed stage's backend", () => {
    const { stages } = summarizeRound([completed]);
    assert.deepEqual(stages[0].backend, { provider: "nvidia", model: "meta/llama-3.1-70b-instruct" });
  });

  it("reports an answered-but-empty stage as blocked, with the real reason", () => {
    const stalled: RoundTurnLike = {
      agent: "image",
      ok: true,
      backend: { kind: "hosted_nvidia", provider: "nvidia", model: "sdxl" },
      reply: null,
      outgoing: 0,
      applied: [],
      error: null,
    };
    const { outcome, stages, blockers } = summarizeRound([completed, stalled]);
    assert.equal(outcome, "partial");
    assert.equal(stages[1].outcome, "blocked");
    assert.match(blockers[0], /Image AI answered but produced no reply/);
  });

  it("counts a failed call and an offline stage as blocked overall", () => {
    const failed: RoundTurnLike = {
      agent: "voice",
      ok: false,
      backend: { kind: "hosted_nvidia", provider: "nvidia", model: "tts" },
      reply: null,
      outgoing: 0,
      applied: [],
      error: "HTTP_ERROR: 500 upstream",
    };
    const offline: RoundTurnLike = {
      agent: "overseer",
      ok: false,
      backend: null,
      reply: null,
      outgoing: 0,
      applied: [],
      error: "Showrunner is OFFLINE"
    };
    const { outcome, stages, blockers } = summarizeRound([completed, failed, offline]);
    assert.equal(outcome, "blocked");
    assert.equal(stages[1].outcome, "failed");
    assert.equal(stages[2].outcome, "skipped_offline");
    assert.equal(blockers.length, 2);
    assert.match(blockers[1], /was never invoked/);
  });

  it("lists only actually-applied store write refs as artifacts", () => {
    const turn: RoundTurnLike = {
      ...completed,
      reply: null,
      outgoing: 2,
      applied: [
        { op: "create_character", ok: true, ref: "char-9" },
        { op: "create_location", ok: false, ref: null },
        { op: "create_episode", ok: true, ref: "ep-1" },
      ],
    };
    const { stages } = summarizeRound([turn]);
    assert.deepEqual(stages[0].artifacts, ["char-9", "ep-1"]);
    assert.match(stages[0].reason, /2 store write/);
  });

  it("reports a peer-message-only turn as completed", () => {
    const turn: RoundTurnLike = { ...completed, reply: null, applied: [] };
    const { stages } = summarizeRound([turn]);
    assert.equal(stages[0].outcome, "completed");
    assert.match(stages[0].reason, /1 peer message/);
  });
});
