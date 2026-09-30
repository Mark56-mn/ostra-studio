"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TopNav } from "@/components/TopNav";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import {
  actionLabel,
  actionTone,
  backendLabel,
  createRoom,
  fetchStore,
  formatClock,
  listMessages,
  listRooms,
  mergeMessages,
  patchRoom,
  reasoningWords,
  sendMessage,
  type AgentStatus,
  type ChatBackend,
  type ChatMessage,
  type ChatRoom,
  type ProjectRef,
  type StoreSnapshot,
} from "@/lib/chat";

const POLL_MESSAGES_MS = 3000;
const POLL_STORE_MS = 6000;

export default function ChatPage() {
  const [rooms, setRooms] = useState<ChatRoom[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [projects, setProjects] = useState<ProjectRef[]>([]);
  const [snapshot, setSnapshot] = useState<StoreSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [lastTurn, setLastTurn] = useState<{ applied: number; failed: number; rejected: string[]; backend: ChatBackend } | null>(null);
  const [newRoomTitle, setNewRoomTitle] = useState("");
  const [newRoomProject, setNewRoomProject] = useState("");

  const thinkingRef = useRef(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const activeRoom = useMemo(() => rooms?.find((r) => r.id === activeId) ?? null, [rooms, activeId]);
  const projectId = activeRoom?.project_id ?? null;

  const refreshRooms = useCallback(async () => {
    const r = await listRooms();
    if (!r.ok) {
      setErr(r.error);
      setRooms([]);
      return;
    }
    setRooms(r.data);
    setActiveId((prev) => prev ?? r.data[0]?.id ?? null);
  }, []);

  const refreshStore = useCallback(async (pid: string | null) => {
    const r = await fetchStore(pid);
    if (!r.ok) return;
    setProjects(r.data.projects);
    if (pid) setSnapshot(r.data.snapshot);
    else setSnapshot(null);
  }, []);

  // Initial load: rooms + the project list the room can be bound to.
  useEffect(() => {
    void refreshRooms();
    void refreshStore(null);
  }, [refreshRooms, refreshStore]);

  // Transcript for the active room.
  const loadTranscript = useCallback(async (roomId: string) => {
    const r = await listMessages(roomId);
    if (!r.ok) {
      setErr(r.error);
      return;
    }
    setErr(null);
    setMessages(r.data.messages);
    if (r.data.agent) setAgent(r.data.agent);
  }, []);

  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    void loadTranscript(activeId);
  }, [activeId, loadTranscript]);

  // Live transcript: anything the agent (or another tab) writes shows up without a reload.
  useEffect(() => {
    if (!activeId) return;
    const iv = setInterval(async () => {
      if (thinkingRef.current) return;
      const r = await listMessages(activeId);
      if (!r.ok) return;
      setMessages((prev) => mergeMessages(prev, r.data.messages));
      if (r.data.agent) setAgent(r.data.agent);
    }, POLL_MESSAGES_MS);
    return () => clearInterval(iv);
  }, [activeId]);

  // Live store: the panel re-reads the real tables while the agent works.
  useEffect(() => {
    void refreshStore(projectId);
    const iv = setInterval(() => void refreshStore(projectId), POLL_STORE_MS);
    return () => clearInterval(iv);
  }, [projectId, refreshStore]);

  // Elapsed seconds while waiting — a 1.7B model on a Kaggle tunnel is not instant.
  useEffect(() => {
    if (!thinking) return;
    const iv = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(iv);
  }, [thinking]);

  // Keep the newest message in view.
  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, thinking]);

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    const content = draft.trim();
    if (!content || !activeId || thinking) return;
    setDraft("");
    setErr(null);
    setLastTurn(null);
    setElapsed(0);
    setThinking(true);
    thinkingRef.current = true;
    try {
      const res = await sendMessage(activeId, content);
      if (res.ok) {
        setMessages((prev) => mergeMessages(prev, [res.data.user_message, res.data.message]));
        setAgent(res.data.agent);
        setLastTurn({
          applied: res.data.store.changed,
          failed: res.data.store.failed,
          rejected: res.data.rejected ?? [],
          backend: res.data.backend,
        });
        // If the agent just created the project this room had none of, bind the room to it so the
        // live store panel follows the story instead of staying empty.
        const created = res.data.applied.find((a) => a.op === "create_project" && a.ok && a.id);
        let nextProjectId = projectId;
        if (created?.id && !projectId) {
          const bound = await patchRoom(activeId, { project_id: created.id });
          if (bound.ok) {
            nextProjectId = bound.data.project_id;
            setRooms((prev) => (prev ? prev.map((room) => (room.id === bound.data.id ? bound.data : room)) : prev));
          }
        }
        await refreshStore(nextProjectId);
        await refreshRooms();
      } else {
        if (res.userMessage) setMessages((prev) => mergeMessages(prev, [res.userMessage as ChatMessage]));
        if (res.agent) setAgent(res.agent);
        setErr(res.error);
      }
    } finally {
      thinkingRef.current = false;
      setThinking(false);
    }
  }

  async function onCreateRoom(e: React.FormEvent) {
    e.preventDefault();
    const r = await createRoom(newRoomProject || null, newRoomTitle.trim() || undefined);
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

  async function onRebindRoom(pid: string) {
    if (!activeId) return;
    const r = await patchRoom(activeId, { project_id: pid || null });
    if (!r.ok) {
      setErr(r.error);
      return;
    }
    setErr(null);
    setRooms((prev) => (prev ? prev.map((room) => (room.id === r.data.id ? r.data : room)) : prev));
    await refreshStore(pid || null);
  }

  const online = agent?.available === true;
  const isProjectModel = agent?.kind === "project_worker";

  return (
    <div className="min-h-screen bg-[#070A14]">
      <TopNav />
      <main className="mx-auto max-w-[1240px] space-y-4 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="label-mono text-[#6B7594]">AGENT CHAT — REAL MODEL, REAL STORE</div>
            <h1 className="text-[22px] font-bold tracking-tight text-white">Studio Agent Room</h1>
            <p className="mt-1 max-w-[70ch] text-[13px] leading-5 text-[#9AA3C0]">
              Describe an idea in plain language. The agent answers with the project&apos;s own model and can
              write characters, locations, episodes and scenes straight into the store — every change it made is
              listed on its message.
            </p>
          </div>
          <div className="flex flex-col items-start gap-2 sm:items-end">
            {agent === null ? (
              <Badge variant="idle" dot>
                ASKING THE BACKEND…
              </Badge>
            ) : online ? (
              <Badge variant={isProjectModel ? "online" : "warn"} dot>
                {isProjectModel ? "SCRIPT AI ONLINE" : "HOSTED FALLBACK"}
                {agent.model ? ` · ${agent.model}` : ""}
              </Badge>
            ) : (
              <Badge variant="offline" dot>
                NO MODEL ONLINE
              </Badge>
            )}
            {agent && (
              <div className="max-w-[46ch] text-right text-[11px] leading-4 text-[#6B7594]">{agent.detail}</div>
            )}
          </div>
        </div>

        {err && (
          <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-[13px] text-red-200">
            <span className="font-semibold">TURN FAILED.</span> {err}
          </div>
        )}

        {!online && agent && (
          <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-[13px] leading-5 text-amber-200">
            <span className="font-semibold">NO AI IS AVAILABLE TO ANSWER.</span> Nothing is simulated — your message is
            still saved, and a real answer needs either the Script AI runtime ONLINE (start it from{" "}
            <span className="font-mono text-[12px]">/runtimes</span>) or a hosted fallback key configured on the backend.
            {agent.candidates.length > 0 && (
              <ul className="mt-2 space-y-1 font-mono text-[11px] text-amber-300/90">
                {agent.candidates.map((c, i) => (
                  <li key={`${c.workerId ?? "w"}-${i}`}>
                    {c.provider}: {c.status} — {c.reason}
                    {c.endpointHost ? ` (${c.endpointHost})` : " (no endpoint registered)"}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {lastTurn && (
          <div className="rounded-xl border border-white/[0.07] bg-[#131A32]/70 px-4 py-3 text-[12px] text-[#9AA3C0]">
            <span className="font-semibold text-white">Last turn:</span> {lastTurn.applied} store change
            {lastTurn.applied === 1 ? "" : "s"} applied
            {lastTurn.failed > 0 ? `, ${lastTurn.failed} refused` : ""} · answered by{" "}
            {lastTurn.backend.model} ({lastTurn.backend.kind === "project_worker" ? "project runtime" : "hosted fallback"})
            {lastTurn.rejected.length > 0 ? ` · ignored unsupported request: ${lastTurn.rejected.join(", ")}` : ""}
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-[250px_minmax(0,1fr)_300px]">
          {/* TRANSCRIPT */}
          <Card className="order-1 flex min-h-[62vh] flex-col lg:order-2" padding={false}>
            <div className="border-b border-white/[0.06] px-4 py-3">
              <div className="label-mono text-[#6B7594]">{activeRoom ? "ROOM" : "NO ROOM SELECTED"}</div>
              <div className="text-[15px] font-semibold text-white">{activeRoom?.title ?? "Create a room to begin"}</div>
            </div>

            <div ref={scrollerRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4" style={{ maxHeight: "56vh" }}>
              {messages.length === 0 && !thinking && (
                <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-8 text-center text-[13px] leading-6 text-[#6B7594]">
                  No messages yet. Try: <span className="text-white">“I want a story about a calligrapher whose ink
                  rewrites reality — set up the project, the two leads and episode one.”</span>
                </div>
              )}
              {messages.map((m) => (
                <MessageRow key={m.id} message={m} />
              ))}
              {thinking && (
                <div className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.03] px-4 py-3 text-[12px] text-[#9AA3C0]">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#3DE0B3]" />
                  {agent?.kind === "project_worker" ? "Script AI" : "Fallback model"} is thinking… {elapsed}s
                  {elapsed > 20 && <span className="text-[#6B7594]">(a small model on a tunnel can take a while)</span>}
                </div>
              )}
            </div>

            <form onSubmit={onSend} className="border-t border-white/[0.06] p-3">
              <div className="flex items-end gap-2">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void onSend(e);
                    }
                  }}
                  rows={2}
                  disabled={!activeId || thinking}
                  placeholder={activeId ? "Describe the story, a character, a scene… (Enter to send, Shift+Enter for a new line)" : "Create a room first"}
                  className="min-h-[52px] w-full resize-y rounded-xl border border-white/10 bg-[#070A14] px-3 py-2 text-[13px] leading-5 text-white placeholder:text-zinc-500 disabled:opacity-60"
                />
                <button
                  type="submit"
                  disabled={!activeId || thinking || !draft.trim()}
                  className="shrink-0 rounded-full bg-[#FF4D5A] px-5 py-2.5 text-[13px] font-semibold text-white shadow-[0_8px_20px_rgba(255,77,90,0.35)] transition hover:bg-[#ff5e6a] disabled:opacity-50"
                >
                  {thinking ? "Working…" : "Send"}
                </button>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[#6B7594]">
                <span>
                  Model: <span className="text-zinc-300">{agent?.model ?? (agent === null ? "checking…" : "none online")}</span>
                </span>
                {agent?.endpointHost && <span className="font-mono">{agent.endpointHost}</span>}
                <span>· additive writes only — the agent cannot delete anything</span>
              </div>
            </form>
          </Card>

          {/* ROOMS */}
          <div className="order-2 space-y-4 lg:order-1">
            <Card padding={false}>
              <div className="border-b border-white/[0.06] px-4 py-3">
                <div className="label-mono text-[#6B7594]">ROOMS</div>
                <div className="text-[15px] font-semibold text-white">{rooms?.length ?? 0} conversation{rooms?.length === 1 ? "" : "s"}</div>
              </div>
              <div className="max-h-[42vh] space-y-2 overflow-y-auto p-3">
                {rooms === null && <div className="py-6 text-center text-[13px] text-[#6B7594]">Loading…</div>}
                {rooms?.length === 0 && (
                  <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-3 py-5 text-center text-[12px] leading-5 text-[#6B7594]">
                    No rooms yet. Create one below — bind it to a project so the agent writes into that store.
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
                <div className="label-mono text-[#6B7594]">NEW ROOM</div>
                <input
                  value={newRoomTitle}
                  onChange={(e) => setNewRoomTitle(e.target.value)}
                  placeholder="Room name — e.g. Crimson Ink brainstorm"
                  className="w-full rounded-lg border border-white/10 bg-[#070A14] px-3 py-2 text-[13px] text-white placeholder:text-zinc-500"
                />
                <select
                  value={newRoomProject}
                  onChange={(e) => setNewRoomProject(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-[#070A14] px-3 py-2 text-[13px] text-white"
                >
                  <option value="">No project (agent may create one)</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title} ({p.slug})
                    </option>
                  ))}
                </select>
                <button type="submit" className="w-full rounded-full bg-white px-4 py-2 text-[13px] font-semibold text-[#070A14] hover:bg-zinc-100">
                  Create room
                </button>
              </form>
            </Card>

            <Card>
              <div className="label-mono mb-2 text-[#6B7594]">HOW THIS WORKS</div>
              <ul className="space-y-2 text-[12px] leading-5 text-[#9AA3C0]">
                <li>• Your message goes to the Script AI worker this app actually runs; if none is ONLINE the backend says so instead of inventing an answer.</li>
                <li>• The agent sees the real store (project, cast, locations, episodes, scenes) at the moment you send.</li>
                <li>• It can only ask for additive operations — creating and updating. Deleting is impossible.</li>
                <li>• Every applied write is shown on the message and written to the audit log, so the store never changes silently.</li>
              </ul>
            </Card>
          </div>

          {/* STORE */}
          <div className="order-3 space-y-4">
            <Card>
              <CardHeader
                kicker="THE STORE"
                title={snapshot?.project ? snapshot.project.title : "No project bound"}
                action={
                  <button
                    onClick={() => void refreshStore(projectId)}
                    className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-medium text-white hover:bg-white/10"
                  >
                    Refresh
                  </button>
                }
              />
              <label className="label-mono mb-1 block text-[#6B7594]">AGENT WRITES INTO</label>
              <select
                value={projectId ?? ""}
                onChange={(e) => void onRebindRoom(e.target.value)}
                disabled={!activeId}
                className="mb-3 w-full rounded-lg border border-white/10 bg-[#070A14] px-3 py-2 text-[13px] text-white disabled:opacity-60"
              >
                <option value="">No project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title} ({p.slug})
                  </option>
                ))}
              </select>

              {!snapshot?.project ? (
                <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-3 py-5 text-center text-[12px] leading-5 text-[#6B7594]">
                  Bind this room to a project (or ask the agent to create one) and the live store appears here.
                </div>
              ) : (
                <div className="space-y-3">
                  <StoreSection label="CHARACTERS" count={snapshot.characters.length}>
                    {snapshot.characters.map((c, i) => (
                      <li key={`${c.name}-${i}`} className="text-[12px] leading-5 text-[#9AA3C0]">
                        <span className="text-white">{c.name}</span>
                        {c.role ? <span className="text-[#6B7594]"> · {c.role}</span> : null}
                      </li>
                    ))}
                  </StoreSection>
                  <StoreSection label="LOCATIONS" count={snapshot.locations.length}>
                    {snapshot.locations.map((l, i) => (
                      <li key={`${l.name}-${i}`} className="text-[12px] leading-5 text-[#9AA3C0]">
                        <span className="text-white">{l.name}</span>
                      </li>
                    ))}
                  </StoreSection>
                  <StoreSection label="EPISODES" count={snapshot.episodes.length}>
                    {snapshot.episodes.map((ep) => {
                      const scenes = snapshot.scenes.filter((s) => s.episode_number === ep.number);
                      return (
                        <li key={ep.number} className="text-[12px] leading-5 text-[#9AA3C0]">
                          <span className="text-white">
                            EP {String(ep.number).padStart(2, "0")} · {ep.title}
                          </span>{" "}
                          <span className="font-mono text-[10px] text-[#6B7594]">[{ep.status}]</span>
                          {scenes.length > 0 && (
                            <div className="pl-2 font-mono text-[10px] text-[#6B7594]">
                              {scenes.map((s) => `#${s.index}${s.title ? ` ${s.title}` : ""}`).join(" · ")}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </StoreSection>
                  <div className="pt-1 text-[10px] text-[#6B7594]">
                    read {formatClock(snapshot.taken_at)} · refreshes every {POLL_STORE_MS / 1000}s
                  </div>
                </div>
              )}
            </Card>

            <Card>
              <div className="label-mono mb-2 text-[#6B7594]">PROJECT LINK</div>
              <div className="text-[12px] leading-5 text-[#9AA3C0]">
                The same rows the Studio, Projects and Runner pages use. Open{" "}
                <span className="font-mono text-[11px] text-white">/projects</span> to see what the agent wrote.
              </div>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}

function MessageRow({ message }: { message: ChatMessage }) {
  const mine = message.role === "user";
  const backend = backendLabel(message.backend);
  const words = mine ? 0 : reasoningWords(message.reasoning);
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[86%] rounded-2xl border px-4 py-3 ${
          mine ? "border-[#FF4D5A]/30 bg-[#FF4D5A]/10" : "border-white/[0.07] bg-[#0F1425]"
        }`}
      >
        <div className="mb-1 flex items-center gap-2">
          <span className="label-mono text-[#6B7594]">{mine ? "DIRECTOR" : "SCRIPT AI"}</span>
          <span className="text-[10px] text-[#6B7594]">{formatClock(message.created_at)}</span>
        </div>

        {/* The model's thinking, kept in its own collapsible block so it never reads as the answer.
            Rendered only when a real reasoning trace exists — a model that did not think shows none. */}
        {words > 0 && (
          <details className="group mb-2 rounded-lg border border-white/[0.06] bg-[#070A14]/60">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-[11px] text-[#6B7594] transition hover:text-[#9AA3C0] [&::-webkit-details-marker]:hidden">
              <span aria-hidden className="text-[9px] transition-transform group-open:rotate-90">▶</span>
              <span className="label-mono">THINKING</span>
              <span className="text-[#4C5570]">· {words} words — reasoning, not the answer</span>
            </summary>
            <div className="max-h-64 overflow-y-auto whitespace-pre-wrap border-t border-white/[0.06] px-2.5 py-2 font-mono text-[11px] leading-5 text-[#8B94B4]">
              {message.reasoning}
            </div>
          </details>
        )}

        <div className="whitespace-pre-wrap text-[13px] leading-6 text-[#E8ECF8]">{message.content}</div>

        {message.actions.length > 0 && (
          <ul className="mt-2 space-y-1 border-t border-white/[0.06] pt-2">
            {message.actions.map((a, i) => (
              <li
                key={`${a.op}-${a.id ?? i}`}
                className={`flex items-start gap-1.5 text-[11px] leading-4 ${
                  actionTone(a) === "ok" ? "text-emerald-300" : "text-red-300"
                }`}
              >
                <span aria-hidden>{actionTone(a) === "ok" ? "✓" : "✗"}</span>
                <span>{actionLabel(a)}</span>
              </li>
            ))}
          </ul>
        )}

        {backend && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-[#6B7594]">
            <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 font-mono">{backend}</span>
            {message.backend?.latencyMs != null && <span>{Math.round(message.backend.latencyMs / 100) / 10}s</span>}
            {message.backend?.parse === "text_fallback" && <span>prose reply (no JSON envelope)</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function StoreSection({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="label-mono text-[#6B7594]">{label}</span>
        <span className="font-mono text-[10px] text-[#6B7594]">{count}</span>
      </div>
      {count === 0 ? (
        <div className="text-[12px] leading-5 text-[#4C5570]">none</div>
      ) : (
        <ul className="mt-0.5 space-y-0.5">{children}</ul>
      )}
    </div>
  );
}
