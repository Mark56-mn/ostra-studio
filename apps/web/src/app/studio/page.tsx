"use client";
// apps/web/src/app/studio/page.tsx
// AI STUDIO — the production channel where the agents talk to each other and the Showrunner reports
// to the director. Everything on this page comes from the Render API; nothing is simulated.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TopNav } from "@/components/TopNav";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { formatClock } from "@/lib/chat";
import {
  agentLabel,
  answeredCount,
  createStudioRoom,
  dispatchRound,
  listChannel,
  listStudioRooms,
  participantAccent,
  patchStudioRoom,
  statusLabel,
  turnSentence,
  type AgentTurnResult,
  type ChannelMessage,
  type ProjectRef,
  type RosterEntry,
  type StudioRoom,
} from "@/lib/agents";

const POLL_MS = 5000;

type ProjectList = ProjectRef[];

export default function StudioPage() {
  const [rooms, setRooms] = useState<StudioRoom[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [roster, setRoster] = useState<RosterEntry[] | null>(null);
  const [projects, setProjects] = useState<ProjectList>([]);
  const [err, setErr] = useState<string | null>(null);
  const [brief, setBrief] = useState("");
  const [withOverseer, setWithOverseer] = useState(true);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [turns, setTurns] = useState<AgentTurnResult[] | null>(null);
  const [summary, setSummary] = useState<{ changed: number; failed: number } | null>(null);
  const [newRoomTitle, setNewRoomTitle] = useState("");
  const [newRoomProject, setNewRoomProject] = useState("");

  const runningRef = useRef(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const activeRoom = useMemo(() => rooms?.find((r) => r.id === activeId) ?? null, [rooms, activeId]);
  const projectId = activeRoom?.project_id ?? null;

  const refreshRooms = useCallback(async () => {
    const r = await listStudioRooms();
    if (!r.ok) {
      setErr(r.error);
      setRooms([]);
      return;
    }
    setRooms(r.data);
    setActiveId((prev) => prev ?? r.data[0]?.id ?? null);
    // Rooms carry no project list; reuse the chat store endpoint for the binding picker.
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL?.replace(/\/+$/, "") ?? ""}/api/chat/store`, { cache: "no-store" });
      if (res.ok) {
        const json = (await res.json()) as { projects?: ProjectRef[] };
        setProjects(json.projects ?? []);
      }
    } catch {
      /* the project picker is optional; the channel still works */
    }
  }, []);

  const loadChannel = useCallback(async (roomId: string) => {
    const r = await listChannel(roomId);
    if (!r.ok) {
      setErr(r.error);
      return;
    }
    setErr(null);
    setMessages(r.data.messages);
    setRoster(r.data.roster);
  }, []);

  useEffect(() => {
    void refreshRooms();
  }, [refreshRooms]);

  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    void loadChannel(activeId);
  }, [activeId, loadChannel]);

  useEffect(() => {
    if (!activeId) return;
    const iv = setInterval(() => {
      if (runningRef.current) return;
      void loadChannel(activeId);
    }, POLL_MS);
    return () => clearInterval(iv);
  }, [activeId, loadChannel]);

  useEffect(() => {
    if (!running) return;
    const iv = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(iv);
  }, [running]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, running]);

  async function onRun(e: React.FormEvent) {
    e.preventDefault();
    if (!activeId || running) return;
    const text = brief.trim();
    setErr(null);
    setTurns(null);
    setSummary(null);
    setElapsed(0);
    setRunning(true);
    runningRef.current = true;
    try {
      const res = await dispatchRound(activeId, { brief: text || undefined, overseer: withOverseer });
      if (!res.ok) {
        setErr(res.error);
        // The brief may still have been saved before the round failed; refresh honestly.
        await loadChannel(activeId);
        return;
      }
      setBrief("");
      setMessages(res.data.messages);
      setRoster(res.data.roster);
      setTurns(res.data.turns);
      setSummary({ changed: res.data.changed, failed: res.data.failedWrites });
      await refreshRooms();
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }

  async function onCreateRoom(e: React.FormEvent) {
    e.preventDefault();
    const r = await createStudioRoom(newRoomProject || null, newRoomTitle.trim() || undefined);
    if (!r.ok) {
      setErr(r.error);
      return;
    }
    setNewRoomTitle("");
    setErr(null);
    await refreshRooms();
    setActiveId(r.data.id);
    setMessages([]);
  }

  async function onRebind(pid: string) {
    if (!activeId) return;
    const r = await patchStudioRoom(activeId, { project_id: pid || null });
    if (!r.ok) {
      setErr(r.error);
      return;
    }
    setRooms((prev) => (prev ? prev.map((room) => (room.id === r.data.id ? r.data : room)) : prev));
  }

  const onlineCount = (roster ?? []).filter((r) => r.available).length;

  return (
    <div className="min-h-screen bg-[#070A14]">
      <TopNav />
      <main className="mx-auto max-w-[1240px] space-y-4 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="label-mono text-[#6B7594]">AI STUDIO — AGENTS TALK TO EACH OTHER</div>
            <h1 className="text-[22px] font-bold tracking-tight text-white">Production Channel</h1>
            <p className="mt-1 max-w-[74ch] text-[13px] leading-5 text-[#9AA3C0]">
              Give the channel a brief and run a round: <span className="text-white">Script AI</span> writes the story and
              briefs the picture, <span className="text-white">Image AI</span> answers on how everything looks,{" "}
              <span className="text-white">Voice AI</span> says how it should sound against each scene, and the{" "}
              <span className="text-white">Showrunner</span> reports the real status back to you. Every message below is one
              that was actually sent.
            </p>
          </div>
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <Badge variant={onlineCount > 0 ? "online" : "offline"} dot>
              {roster === null ? "CHECKING ROSTER…" : `${onlineCount} of ${roster.length} agents online`}
            </Badge>
            {activeRoom && (
              <div className="max-w-[46ch] text-right text-[11px] leading-4 text-[#6B7594]">
                {activeRoom.title}
                {projectId ? " · project bound" : " · no project bound"}
              </div>
            )}
          </div>
        </div>

        {err && (
          <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-[13px] text-red-200">
            <span className="font-semibold">FAILED.</span> {err}
          </div>
        )}
        {roster !== null && onlineCount === 0 && (
          <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-[13px] leading-5 text-amber-200">
            <span className="font-semibold">NO AGENT IS ONLINE.</span> Nothing is simulated — a round needs at least one agent
            runtime with a fresh heartbeat. Start one from the <span className="font-mono text-[12px]">Runner</span> page. Rows
            below explain exactly what the backend found.
          </div>
        )}

        {/* ROSTER */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {(roster ?? []).map((a) => (
            <div key={a.kind} className={`rounded-2xl border p-3 ${a.available ? "border-white/[0.08] bg-[#0F1425]" : "border-white/[0.05] bg-white/[0.02]"}`}>
              <div className="flex items-center justify-between gap-2">
                <span className={`text-[13px] font-semibold ${a.accent}`}>{a.label}</span>
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-wide ${a.available ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-white/10 bg-white/[0.04] text-zinc-400"}`}>
                  {a.available ? "ONLINE" : "OFFLINE"}
                </span>
              </div>
              <p className="mt-1.5 text-[11px] leading-4 text-[#9AA3C0]">{a.specialty}</p>
              <div className="mt-2 space-y-0.5 font-mono text-[10px] text-[#6B7594]">
                <div className="truncate">{a.model ?? "no model"} · {a.provider ?? "—"}</div>
                <div className="truncate">{a.endpointHost ?? "no endpoint registered"}</div>
              </div>
            </div>
          ))}
          {roster === null &&
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-[104px] animate-pulse rounded-2xl border border-white/[0.06] bg-white/[0.02]" />
            ))}
        </div>

        <div className="grid gap-4 lg:grid-cols-[250px_minmax(0,1fr)_300px]">
          {/* CHANNEL */}
          <Card className="order-1 flex min-h-[62vh] flex-col lg:order-2" padding={false}>
            <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
              <div>
                <div className="label-mono text-[#6B7594]">{activeRoom ? "CHANNEL" : "NO CHANNEL SELECTED"}</div>
                <div className="text-[15px] font-semibold text-white">{activeRoom?.title ?? "Create a channel to begin"}</div>
              </div>
              {messages.length > 0 && <span className="font-mono text-[10px] text-[#6B7594]">{messages.length} messages</span>}
            </div>

            <div ref={scrollerRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4" style={{ maxHeight: "52vh" }}>
              {messages.length === 0 && !running && (
                <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-8 text-center text-[13px] leading-6 text-[#6B7594]">
                  Nothing has been said yet. Try:{" "}
                  <span className="text-white">“Episode 1: Kai discovers the scar on his left cheek was painted on. Brief the picture and the sound.”</span>
                </div>
              )}
              {messages.map((m) => (
                <ChannelRow key={m.id} message={m} />
              ))}
              {running && (
                <div className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.03] px-4 py-3 text-[12px] text-[#9AA3C0]">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#3DE0B3]" />
                  Running the round… {elapsed}s
                  <span className="text-[#6B7594]">(each agent thinks in turn — a small model on a tunnel can take a while)</span>
                </div>
              )}
            </div>

            <form onSubmit={onRun} className="border-t border-white/[0.06] p-3">
              <textarea
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void onRun(e);
                  }
                }}
                rows={2}
                disabled={!activeId || running}
                placeholder={activeId ? "Brief the channel — what should this round produce? (⌘/Ctrl+Enter to run)" : "Create a channel first"}
                className="min-h-[52px] w-full resize-y rounded-xl border border-white/10 bg-[#070A14] px-3 py-2 text-[13px] leading-5 text-white placeholder:text-zinc-500 disabled:opacity-60"
              />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <label className="flex cursor-pointer items-center gap-2 text-[11px] text-[#9AA3C0]">
                  <input type="checkbox" checked={withOverseer} onChange={(e) => setWithOverseer(e.target.checked)} className="accent-[#FF4D5A]" />
                  End with a Showrunner report
                </label>
                <button
                  type="submit"
                  disabled={!activeId || running || !brief.trim()}
                  className="rounded-full bg-[#FF4D5A] px-5 py-2.5 text-[13px] font-semibold text-white shadow-[0_8px_20px_rgba(255,77,90,0.35)] transition hover:bg-[#ff5e6a] disabled:opacity-50"
                >
                  {running ? "Running…" : "Run production round"}
                </button>
              </div>
            </form>
          </Card>

          {/* CHANNELS */}
          <div className="order-2 space-y-4 lg:order-1">
            <Card padding={false}>
              <div className="border-b border-white/[0.06] px-4 py-3">
                <div className="label-mono text-[#6B7594]">CHANNELS</div>
                <div className="text-[15px] font-semibold text-white">
                  {rooms?.length ?? 0} production channel{rooms?.length === 1 ? "" : "s"}
                </div>
              </div>
              <div className="max-h-[42vh] space-y-2 overflow-y-auto p-3">
                {rooms === null && <div className="py-6 text-center text-[13px] text-[#6B7594]">Loading…</div>}
                {rooms?.length === 0 && (
                  <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-3 py-5 text-center text-[12px] leading-5 text-[#6B7594]">
                    No channels yet. Create one — bind it to a project so the agents write into that store.
                  </div>
                )}
                {rooms?.map((r) => {
                  const bound = projects.find((p) => p.id === r.project_id);
                  const active = r.id === activeId;
                  return (
                    <button
                      key={r.id}
                      onClick={() => setActiveId(r.id)}
                      className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${
                        active ? "border-[#FF4D5A]/40 bg-[#FF4D5A]/10" : "border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.06]"
                      }`}
                    >
                      <div className="truncate text-[13px] font-semibold text-white">{r.title}</div>
                      <div className="truncate font-mono text-[10px] text-[#6B7594]">{bound?.slug ?? "no project bound"}</div>
                    </button>
                  );
                })}
              </div>

              <form onSubmit={onCreateRoom} className="space-y-2 border-t border-white/[0.06] p-3">
                <div className="label-mono text-[#6B7594]">NEW CHANNEL</div>
                <input
                  value={newRoomTitle}
                  onChange={(e) => setNewRoomTitle(e.target.value)}
                  placeholder="Channel name — e.g. EP1 production"
                  className="w-full rounded-lg border border-white/10 bg-[#070A14] px-3 py-2 text-[13px] text-white placeholder:text-zinc-500"
                />
                <select
                  value={newRoomProject}
                  onChange={(e) => setNewRoomProject(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-[#070A14] px-3 py-2 text-[13px] text-white"
                >
                  <option value="">No project bind</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title} ({p.slug})
                    </option>
                  ))}
                </select>
                <button type="submit" className="w-full rounded-full bg-white px-4 py-2 text-[13px] font-semibold text-[#070A14] hover:bg-zinc-100">
                  Create channel
                </button>
              </form>
            </Card>

            <Card>
              <div className="label-mono mb-2 text-[#6B7594]">HOW A ROUND WORKS</div>
              <ul className="space-y-2 text-[12px] leading-5 text-[#9AA3C0]">
                <li>• Your brief is saved first, then each agent runs once, in order: Script → Image → Voice → Showrunner.</li>
                <li>• Each agent reads the whole channel and the real store, and can request additive store changes only.</li>
                <li>• An offline agent is skipped and reported; nothing is written on its behalf.</li>
                <li>• Press run again to continue the conversation from where it stopped.</li>
              </ul>
            </Card>
          </div>

          {/* RIGHT: binding + last round */}
          <div className="order-3 space-y-4">
            <Card>
              <CardHeader kicker="CHANNEL PROJECT" title={activeRoom?.title ?? "No channel"} />
              <label className="label-mono mb-1 block text-[#6B7594]">AGENTS WRITE INTO</label>
              <select
                value={projectId ?? ""}
                onChange={(e) => void onRebind(e.target.value)}
                disabled={!activeId}
                className="w-full rounded-lg border border-white/10 bg-[#070A14] px-3 py-2 text-[13px] text-white disabled:opacity-60"
              >
                <option value="">No project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title} ({p.slug})
                  </option>
                ))}
              </select>
              <p className="mt-2 text-[11px] leading-4 text-[#6B7594]">
                The same store the Agent Chat room and the Studio pages use. Every write is listed on the message and
                audited in <span className="font-mono">events</span>.
              </p>
            </Card>

            <Card>
              <CardHeader kicker="LAST ROUND" title={turns ? `${answeredCount(turns)} of ${turns.length} agents answered` : "No round run yet"} />
              {!turns ? (
                <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-3 py-5 text-center text-[12px] leading-5 text-[#6B7594]">
                  Run a round and the honest per-agent result appears here — including the agents that could not run.
                </div>
              ) : (
                <div className="space-y-2">
                  {summary && (
                    <div className="rounded-lg border border-white/[0.06] bg-[#070A14]/60 px-3 py-2 text-[11px] text-[#9AA3C0]">
                      {summary.changed} store change{summary.changed === 1 ? "" : "s"} applied
                      {summary.failed > 0 ? `, ${summary.failed} refused` : ""}
                    </div>
                  )}
                  {turns.map((t) => (
                    <div
                      key={t.agent}
                      className={`rounded-xl border px-3 py-2 text-[12px] leading-5 ${
                        t.ok ? "border-white/[0.06] bg-[#0F1425] text-[#C7CEE4]" : "border-amber-500/20 bg-amber-500/[0.06] text-amber-200"
                      }`}
                    >
                      {turnSentence(t)}
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card>
              <div className="label-mono mb-2 text-[#6B7594]">NO FABRICATION</div>
              <div className="text-[12px] leading-5 text-[#9AA3C0]">
                A message only appears once a model actually said it. A status of <span className="text-amber-300">waiting</span>{" "}
                means the recipient has not run yet; <span className="text-red-300">delivery failed</span> carries the real
                reason.
              </div>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}

function reasonWords(reasoning: unknown): number {
  const text = typeof reasoning === "string" ? reasoning.trim() : "";
  return text ? text.split(/\s+/).length : 0;
}

function ChannelRow({ message }: { message: ChannelMessage }) {
  const from = message.from_agent;
  const isDirector = from === "director";
  const toDirector = message.to_agent === "director";
  const status = statusLabel(message.status);
  const reasoning = message.payload?.["reasoning"];
  const words = reasonWords(reasoning);

  return (
    <div className="rounded-2xl border border-white/[0.07] bg-[#0F1425] px-4 py-3">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className={`text-[11px] font-bold tracking-wide ${participantAccent(from)}`}>{agentLabel(from)}</span>
        <span aria-hidden className="text-[10px] text-[#4C5570]">
          →
        </span>
        <span className={`text-[11px] font-semibold ${participantAccent(message.to_agent)}`}>{agentLabel(message.to_agent)}</span>
        <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-[#8B94B4]">
          {message.kind}
        </span>
        <span className="text-[10px] text-[#6B7594]">{formatClock(message.created_at)}</span>
        <span
          className={`rounded-full border px-1.5 py-0.5 text-[9px] font-bold tracking-wide ${
            status.tone === "ok"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
              : status.tone === "warn"
                ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
                : status.tone === "bad"
                  ? "border-red-500/30 bg-red-500/10 text-red-300"
                  : "border-white/10 bg-white/[0.04] text-zinc-400"
          }`}
        >
          {status.text}
        </span>
        {isDirector && <span className="label-mono text-[#6B7594]">DIRECTOR</span>}
        {toDirector && !isDirector && <span className="label-mono text-[#6B7594]">TO YOU</span>}
      </div>

      {words > 0 && (
        <details className="group mb-2 rounded-lg border border-white/[0.06] bg-[#070A14]/60">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-[11px] text-[#6B7594] transition hover:text-[#9AA3C0] [&::-webkit-details-marker]:hidden">
            <span aria-hidden className="text-[9px] transition-transform group-open:rotate-90">
              ▶
            </span>
            <span className="label-mono">THINKING</span>
            <span className="text-[#4C5570]">· {words} words — reasoning, not the message</span>
          </summary>
          <div className="max-h-64 overflow-y-auto whitespace-pre-wrap border-t border-white/[0.06] px-2.5 py-2 font-mono text-[11px] leading-5 text-[#8B94B4]">
            {String(reasoning)}
          </div>
        </details>
      )}

      <div className="whitespace-pre-wrap text-[13px] leading-6 text-[#E8ECF8]">{message.content}</div>

      {message.error && (
        <div className="mt-2 rounded-lg border border-red-500/25 bg-red-500/10 px-2.5 py-1.5 text-[11px] leading-4 text-red-200">
          {message.error.code ? `[${message.error.code}] ` : ""}
          {message.error.reason ?? "delivery failed"}
        </div>
      )}

      {message.backend && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-[#6B7594]">
          <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 font-mono">
            {message.backend.model ?? message.backend.provider}
            {message.backend.kind === "project_worker" ? " · project runtime" : message.backend.kind === "hosted_fallback" ? " · hosted fallback" : ""}
          </span>
          {message.backend.latencyMs != null && <span>{Math.round(message.backend.latencyMs / 100) / 10}s</span>}
          {message.backend.parse === "text_fallback" && <span>prose reply (no JSON envelope)</span>}
        </div>
      )}
    </div>
  );
}
