"use client";

// The Management Team: a hosted model the director talks to, which briefs every production agent
// (Script AI, Image AI, Voice AI) and the Showrunner, and — only when the operator's autonomy gate
// allows it — asks the supervisor to start a runtime.
//
// Everything on this page is read from the API. There is no simulated plan, no optimistic "sent"
// state and no invented agent status: a failed call says what failed, and a refused start says why.

import { useCallback, useEffect, useState } from "react";
import { TopNav } from "@/components/TopNav";
import { Card, CardHeader } from "@/components/ui/Card";
import {
  agentLabel,
  autonomyLabel,
  createStudioRoom,
  dispatchRound,
  fetchManagementPolicy,
  listChannel,
  listStudioRooms,
  manageRoom,
  participantAccent,
  turnSentence,
  type AgentTurnResult,
  type ChannelMessage,
  type ManagementPolicy,
  type RosterEntry,
  type StudioRoom,
} from "@/lib/agents";

const TONE_CLASS: Record<"ok" | "warn" | "bad", string> = {
  ok: "border-emerald-500/25 bg-emerald-500/10 text-emerald-300",
  warn: "border-amber-500/25 bg-amber-500/10 text-amber-300",
  bad: "border-rose-500/25 bg-rose-500/10 text-rose-300",
};

export default function ManagementPage() {
  const [policy, setPolicy] = useState<ManagementPolicy | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [rooms, setRooms] = useState<StudioRoom[]>([]);
  const [roomId, setRoomId] = useState<string>("");
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [brief, setBrief] = useState("");
  const [note, setNote] = useState("");
  const [lastTurn, setLastTurn] = useState<AgentTurnResult | null>(null);
  const [busy, setBusy] = useState<"manage" | "round" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const loadPolicy = useCallback(async () => {
    const r = await fetchManagementPolicy();
    if (r.ok) {
      setPolicy(r.data);
      setPolicyError(null);
    } else {
      setPolicyError(r.error);
    }
  }, []);

  const loadRooms = useCallback(async () => {
    const r = await listStudioRooms();
    if (r.ok) {
      setRooms(r.data);
      setRoomId((prev) => prev || r.data[0]?.id || "");
    }
  }, []);

  const loadChannelNow = useCallback(async (id: string) => {
    if (!id) return;
    const r = await listChannel(id);
    if (r.ok) {
      setMessages(r.data.messages);
      setRoster(r.data.roster);
    }
  }, []);

  useEffect(() => {
    void loadPolicy();
    void loadRooms();
  }, [loadPolicy, loadRooms]);

  useEffect(() => {
    void loadChannelNow(roomId);
    const iv = setInterval(() => void loadChannelNow(roomId), 8000);
    return () => clearInterval(iv);
  }, [roomId, loadChannelNow]);

  async function ensureRoom(): Promise<string | null> {
    if (roomId) return roomId;
    const r = await createStudioRoom(null, "Management channel");
    if (!r.ok) {
      setErr(r.error);
      return null;
    }
    setRoomId(r.data.id);
    setRooms((prev) => [r.data, ...prev]);
    return r.data.id;
  }

  async function sendToManagement() {
    if (busy) return;
    setErr(null);
    setOk(null);
    const id = await ensureRoom();
    if (!id) return;
    setBusy("manage");
    try {
      const r = await manageRoom(id, { brief: brief.trim(), note: note.trim() || undefined });
      if (!r.ok) {
        setErr(r.error);
      } else {
        setLastTurn(r.data.turn);
        setBrief("");
        setMessages(r.data.messages);
        setRoster(r.data.roster);
        const refused = (r.data.turn.starts ?? []).filter((s) => !s.ok);
        setOk(
          `Management Team answered${refused.length ? ` · ${refused.length} runtime start(s) refused` : ""}.`
        );
      }
    } finally {
      setBusy(null);
    }
  }

  async function runRound() {
    if (busy) return;
    setErr(null);
    setOk(null);
    const id = await ensureRoom();
    if (!id) return;
    setBusy("round");
    try {
      const r = await dispatchRound(id, {
        brief: brief.trim() || undefined,
        note: note.trim() || undefined,
      });
      if (!r.ok) {
        setErr(r.error);
      } else {
        setMessages(r.data.messages);
        setRoster(r.data.roster);
        setLastTurn(r.data.turns.find((t) => t.agent === "manager") ?? null);
        const answered = r.data.turns.filter((t) => t.ok).length;
        setOk(`Round finished · ${answered} of ${r.data.turns.length} agents answered · ${r.data.changed} store change(s) applied.`);
      }
    } finally {
      setBusy(null);
    }
  }

  const autonomy = policy ? autonomyLabel(policy.autonomy) : null;

  return (
    <div className="min-h-screen bg-[#070A14]">
      <TopNav />
      <main className="mx-auto max-w-[1100px] space-y-4 px-4 py-6 sm:px-6">
        <div>
          <div className="label-mono text-[#6B7594]">HOSTED MODEL · REAL STATE</div>
          <h1 className="text-[22px] font-bold tracking-tight text-white">Management Team</h1>
          <p className="max-w-[72ch] text-[13px] leading-5 text-[#9AA3C0]">
            The director talks to the management team; it plans the work, instructs Script AI, Image AI, Voice AI and the
            Showrunner through the real channel, and writes the store. It can only start a runtime when the operator
            grants that autonomy, and every start goes through the same supervisor the Run Now button uses.
          </p>
        </div>

        <Card>
          <CardHeader
            kicker="CONFIGURED ON RENDER"
            title="Management status"
            action={
              autonomy ? (
                <span className={`rounded-full border px-3 py-1 text-[11px] font-semibold ${TONE_CLASS[autonomy.tone]}`}>
                  autonomy: {autonomy.text}
                </span>
              ) : null
            }
          />
          {policyError ? (
            <p className="text-[13px] text-rose-300">Could not read the management policy — {policyError}</p>
          ) : !policy ? (
            <p className="text-[13px] text-[#9AA3C0]">Reading the real configuration…</p>
          ) : (
            <div className="space-y-3 text-[13px] leading-5 text-[#C2CBE6]">
              <p>
                <span className="text-white">Model:</span>{" "}
                {policy.available ? `${policy.model} at ${policy.endpointHost} (${policy.provider})` : "not configured"}
              </p>
              <p className="text-[#9AA3C0]">{policy.detail}</p>
              <div className="flex flex-wrap gap-2">
                {policy.startable.length === 0 ? (
                  <span className="text-[12px] text-[#9AA3C0]">No worker has an autostart path.</span>
                ) : (
                  policy.startable.map((s) => (
                    <span
                      key={s.target}
                      title={s.error}
                      className={`rounded-full border px-2.5 py-1 font-mono text-[11px] ${
                        s.ok ? TONE_CLASS.warn : "border-white/10 bg-white/[0.04] text-zinc-400"
                      }`}
                    >
                      start {s.target}: {s.ok ? "allowed" : "refused"}
                    </span>
                  ))
                )}
              </div>
            </div>
          )}
        </Card>

        <div className="grid gap-4 lg:grid-cols-[1.05fr_1fr]">
          <Card>
            <CardHeader kicker="DIRECTOR → MANAGEMENT" title="Give instructions" />
            <div className="space-y-3">
              <select
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                className="w-full rounded-xl border border-white/10 bg-[#0F1425] px-3 py-2 text-[13px] text-white"
              >
                {rooms.length === 0 ? <option value="">New production channel</option> : null}
                {rooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                  </option>
                ))}
              </select>
              <textarea
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                rows={5}
                maxLength={8000}
                placeholder="Build season 1 of the manhwa: three episodes, one hero arc, keep the style bible consistent."
                className="w-full rounded-xl border border-white/10 bg-[#0F1425] px-3 py-2 text-[13px] leading-5 text-white outline-none focus:border-[#FF4D5A]/60"
              />
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional extra note for this turn"
                className="w-full rounded-xl border border-white/10 bg-[#0F1425] px-3 py-2 text-[13px] text-white outline-none focus:border-[#FF4D5A]/60"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={sendToManagement}
                  disabled={busy !== null}
                  className="rounded-full bg-[#FFD166] px-4 py-2 text-[13px] font-semibold text-[#070A14] disabled:opacity-50"
                >
                  {busy === "manage" ? "Thinking…" : "Send to Management Team"}
                </button>
                <button
                  type="button"
                  onClick={runRound}
                  disabled={busy !== null}
                  className="rounded-full border border-white/15 px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
                >
                  {busy === "round" ? "Running round…" : "Brief + run production round"}
                </button>
              </div>
              {err ? <p className="text-[12px] text-rose-300">{err}</p> : null}
              {ok ? <p className="text-[12px] text-emerald-300">{ok}</p> : null}
              {lastTurn ? (
                <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] p-3 text-[12px] leading-5 text-[#C2CBE6]">
                  <div className="label-mono text-[#6B7594]">LAST TURN</div>
                  <p>{turnSentence(lastTurn)}</p>
                  {lastTurn.reply ? <p className="mt-1 text-white">{lastTurn.reply}</p> : null}
                  {(lastTurn.starts ?? []).map((s) => (
                    <p key={s.target} className={s.ok ? "text-emerald-300" : "text-amber-300"}>
                      start {s.target}: {s.action}
                      {s.error ? ` — ${s.error}` : ""}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          </Card>

          <Card>
            <CardHeader kicker="REAL CHANNEL" title="What the team said" />
            <div className="max-h-[520px] space-y-2 overflow-y-auto pr-1">
              {messages.length === 0 ? (
                <p className="text-[13px] text-[#9AA3C0]">
                  Nothing has been said in this channel yet. Every line below is a stored row — nothing is summarised or
                  invented.
                </p>
              ) : (
                messages
                  .slice()
                  .reverse()
                  .map((m) => (
                    <div key={m.id} className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
                      <div className="flex items-center justify-between gap-2 text-[11px] text-[#6B7594]">
                        <span>
                          <span className={participantAccent(m.from_agent)}>{agentLabel(m.from_agent)}</span>
                          {" → "}
                          <span className={participantAccent(m.to_agent)}>{agentLabel(m.to_agent)}</span>
                          <span className="ml-2 font-mono">{m.kind}</span>
                        </span>
                        <span>{new Date(m.created_at).toLocaleTimeString()}</span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-[13px] leading-5 text-[#C2CBE6]">{m.content}</p>
                    </div>
                  ))
              )}
            </div>
          </Card>
        </div>

        <Card>
          <CardHeader kicker="AGENT REGISTRY" title="Who the management team can reach" />
          <div className="grid gap-2 sm:grid-cols-2">
            {roster.length === 0 ? (
              <p className="text-[13px] text-[#9AA3C0]">Roster unavailable — open a channel to load it.</p>
            ) : (
              roster.map((a) => (
                <div key={a.kind} className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-[13px] font-semibold ${participantAccent(a.kind)}`}>{a.label}</span>
                    <span className={`text-[11px] ${a.available ? "text-emerald-300" : "text-[#9AA3C0]"}`}>
                      {a.available ? "ONLINE" : "not answering"}
                    </span>
                  </div>
                  <p className="mt-1 text-[12px] leading-5 text-[#9AA3C0]">{a.specialty}</p>
                  <p className="mt-1 font-mono text-[11px] text-[#6B7594]">{a.model ?? "no model reported"}</p>
                </div>
              ))
            )}
          </div>
        </Card>
      </main>
    </div>
  );
}