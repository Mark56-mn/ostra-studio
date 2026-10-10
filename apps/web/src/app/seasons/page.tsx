"use client";

import { useCallback, useEffect, useState } from "react";
import { TopNav } from "@/components/TopNav";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge, statusVariant } from "@/components/ui/Badge";
import { fetchStore, type ProjectRef } from "@/lib/chat";
import {
  createSeason,
  decideSeason,
  formatDateTime,
  gateLabel,
  listNotifications,
  listSeasons,
  markNotificationRead,
  seasonStatusLabel,
  submitSeason,
  type Notification,
  type ProductionGate,
  type Season,
  type SeasonPackage,
} from "@/lib/seasons";

const EMPTY_PACKAGE: SeasonPackage = {
  title: "",
  premise: null,
  episodes: [],
  characters: [],
  arcs: [],
  ending: null,
  assumptions: [],
  productionEstimate: {},
};

export default function SeasonsPage() {
  const [projects, setProjects] = useState<ProjectRef[]>([]);
  const [projectId, setProjectId] = useState<string>("");
  const [seasons, setSeasons] = useState<Season[] | null>(null);
  const [gates, setGates] = useState<Record<string, ProductionGate>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<Notification[] | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const refresh = useCallback(async (pid: string) => {
    const r = await listSeasons(pid || undefined);
    if (!r.ok) {
      setErr(r.error);
      setSeasons([]);
      return;
    }
    setErr(null);
    setSeasons(r.data.seasons);
    setGates(r.data.gates);
  }, []);

  const refreshNotifications = useCallback(async () => {
    const r = await listNotifications();
    if (r.ok) setNotifications(r.data.notifications);
  }, []);

  useEffect(() => {
    void fetchStore(null).then((r) => {
      if (r.ok) {
        setProjects(r.data.projects);
        setProjectId((prev) => prev || r.data.projects[0]?.id || "");
      }
    });
    void refreshNotifications();
  }, [refreshNotifications]);

  useEffect(() => {
    void refresh(projectId);
  }, [projectId, refresh]);

  const gate = gates[projectId];
  const gateInfo = gateLabel(gate);
  const selected = seasons?.find((s) => s.id === selectedId) ?? null;
  const visible = seasons ?? [];

  async function run(action: string, fn: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    setBusy(action);
    setErr(null);
    setOk(null);
    try {
      const r = await fn();
      if (!r.ok) {
        setErr(r.error ?? "failed");
        return;
      }
      setOk(success);
      setNote("");
      await refresh(projectId);
      await refreshNotifications();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="min-h-screen bg-[#070A14]">
      <TopNav />
      <main className="mx-auto max-w-[1100px] space-y-4 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="label-mono text-[#6B7594]">SEASON-FIRST APPROVAL</div>
            <h1 className="text-[22px] font-bold tracking-tight text-white">Seasons &amp; approvals</h1>
            <p className="mt-1 max-w-[70ch] text-[13px] leading-5 text-[#9AA3C0]">
              The AI team develops a <span className="text-white">complete season package</span> — every episode with a
              synopsis, the cast, the arcs, the ending, its open questions and the production estimate — and submits it
              here. Nothing expensive runs on an unapproved story: <span className="font-mono text-[12px]">POST /api/tasks</span>{" "}
              refuses image, voice, video and YouTube work until a season for that project is approved.
            </p>
          </div>
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <select
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setSelectedId(null);
              }}
              className="rounded-lg border border-white/10 bg-[#070A14] px-3 py-2 text-[13px] text-white"
            >
              {projects.length === 0 && <option value="">No projects yet</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} ({p.slug})
                </option>
              ))}
            </select>
            {projectId && (
              <Badge variant={gateInfo.allowed ? "online" : "warn"} dot>
                {gateInfo.allowed ? "PRODUCTION ALLOWED" : "PRODUCTION BLOCKED"}
              </Badge>
            )}
          </div>
        </div>

        {projectId && (
          <div
            className={`rounded-xl border px-4 py-3 text-[13px] leading-5 ${
              gateInfo.allowed
                ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
                : "border-amber-500/25 bg-amber-500/10 text-amber-200"
            }`}
          >
            <span className="font-semibold">{gateInfo.allowed ? "GATE OPEN. " : "GATE CLOSED. "}</span>
            {gateInfo.text}
          </div>
        )}

        {err && (
          <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-[13px] text-red-200">
            <span className="font-semibold">FAILED.</span> {err}
          </div>
        )}
        {ok && (
          <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-[13px] text-emerald-200">
            {ok}
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          {/* SEASON LIST + INBOX */}
          <div className="space-y-4">
            <Card padding={false}>
              <div className="border-b border-white/[0.06] px-4 py-3">
                <div className="label-mono text-[#6B7594]">SEASONS</div>
                <div className="text-[15px] font-semibold text-white">{visible.length} package{visible.length === 1 ? "" : "s"}</div>
              </div>
              <div className="max-h-[46vh] space-y-2 overflow-y-auto p-3">
                {seasons === null && <div className="py-6 text-center text-[13px] text-[#6B7594]">Loading…</div>}
                {seasons?.length === 0 && (
                  <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-3 py-5 text-center text-[12px] leading-5 text-[#6B7594]">
                    No season package for this project yet. The Manager AI submits one from{" "}
                    <span className="font-mono text-[11px] text-white">/chat</span> or{" "}
                    <span className="font-mono text-[11px] text-white">/studio</span> once it has developed the story.
                  </div>
                )}
                {visible.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setSelectedId(s.id)}
                    className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${
                      selectedId === s.id
                        ? "border-[#FF4D5A]/40 bg-[#FF4D5A]/10"
                        : "border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.06]"
                    }`}
                  >
                    <div className="truncate text-[13px] font-semibold text-white">{s.title}</div>
                    <div className="mt-0.5 text-[11px] text-[#9AA3C0]">{seasonStatusLabel(s.status)}</div>
                    <div className="font-mono text-[10px] text-[#6B7594]">{s.episode_count} episodes · {formatDateTime(s.created_at)}</div>
                  </button>
                ))}
              </div>
            </Card>

            <Card padding={false}>
              <div className="border-b border-white/[0.06] px-4 py-3">
                <div className="label-mono text-[#6B7594]">INBOX</div>
                <div className="text-[15px] font-semibold text-white">
                  {notifications?.filter((n) => !n.read_at).length ?? 0} unread
                </div>
              </div>
              <div className="max-h-[36vh] space-y-2 overflow-y-auto p-3">
                {notifications === null && <div className="py-4 text-center text-[13px] text-[#6B7594]">Loading…</div>}
                {notifications?.length === 0 && (
                  <div className="px-2 py-4 text-center text-[12px] leading-5 text-[#6B7594]">
                    Nothing needs you yet. Season submissions, failed tasks and offline agents land here.
                  </div>
                )}
                {notifications?.map((n) => (
                  <div
                    key={n.id}
                    className={`rounded-xl border px-3 py-2.5 ${n.read_at ? "border-white/[0.05] bg-white/[0.02] opacity-70" : "border-white/[0.08] bg-white/[0.04]"}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-[12px] font-semibold text-white">{n.title}</div>
                      <Badge variant={n.severity === "critical" ? "offline" : n.severity === "warning" ? "warn" : "muted"}>
                        {n.requires_action ? "ACTION NEEDED" : n.severity.toUpperCase()}
                      </Badge>
                    </div>
                    {n.body && <div className="mt-1 text-[11px] leading-4 text-[#9AA3C0]">{n.body}</div>}
                    <div className="mt-1.5 flex items-center justify-between">
                      <span className="font-mono text-[10px] text-[#6B7594]">{formatDateTime(n.created_at)}</span>
                      {!n.read_at && (
                        <button
                          onClick={() => void markNotificationRead(n.id).then(refreshNotifications)}
                          className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-[#9AA3C0] hover:bg-white/10"
                        >
                          Mark read
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {/* PACKAGE DETAIL */}
          <div className="space-y-4">
            {!selected ? (
              <Card>
                <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-10 text-center text-[13px] leading-6 text-[#6B7594]">
                  Select a season package on the left to read exactly what the AI team is proposing — synopsis of every
                  episode, cast, arcs, ending, open assumptions and the production estimate — then approve it, send it
                  back with a note, or reject it.
                </div>
              </Card>
            ) : (
              <>
                <Card>
                  <CardHeader
                    kicker={`SEASON · ${selected.status.toUpperCase()}`}
                    title={selected.title}
                    action={<Badge variant={statusVariant(selected.status)} dot>{selected.status.replace("_", " ").toUpperCase()}</Badge>}
                  />
                  {selected.premise && <p className="text-[13px] leading-6 text-[#E8ECF8]">{selected.premise}</p>}

                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <Section label={`EPISODES (${selected.episodes.length})`}>
                      <ul className="space-y-2">
                        {selected.episodes.map((e) => (
                          <li key={e.number} className="text-[12px] leading-5 text-[#9AA3C0]">
                            <span className="font-mono text-[11px] text-white">EP {String(e.number).padStart(2, "0")}</span>{" "}
                            <span className="font-semibold text-white">{e.title}</span>
                            <div className="pl-8">{e.synopsis}</div>
                          </li>
                        ))}
                      </ul>
                    </Section>

                    <div className="space-y-3">
                      <Section label={`CHARACTERS (${selected.characters.length})`}>
                        <ul className="space-y-1.5">
                          {selected.characters.map((c, i) => (
                            <li key={`${c.name}-${i}`} className="text-[12px] leading-5 text-[#9AA3C0]">
                              <span className="text-white">{c.name}</span>
                              {c.role && <span className="text-[#6B7594]"> · {c.role}</span>}
                              {c.description && <div className="pl-3 text-[11px]">{c.description}</div>}
                            </li>
                          ))}
                        </ul>
                      </Section>

                      <Section label={`ARCS (${selected.arcs.length})`}>
                        <ul className="space-y-1 text-[12px] leading-5 text-[#9AA3C0]">
                          {selected.arcs.map((a, i) => (
                            <li key={`${a}-${i}`}>• {a}</li>
                          ))}
                        </ul>
                      </Section>

                      {selected.ending && (
                        <Section label="ENDING">
                          <div className="text-[12px] leading-5 text-[#9AA3C0]">{selected.ending}</div>
                        </Section>
                      )}

                      <Section label={`OPEN ASSUMPTIONS (${selected.assumptions.length})`}>
                        <ul className="space-y-1.5 text-[12px] leading-5 text-amber-200/90">
                          {selected.assumptions.map((a, i) => (
                            <li key={`${a.question}-${i}`}>
                              Q: {a.question}
                              {a.assumption && <div className="pl-3 text-[#9AA3C0]">assumed: {a.assumption}</div>}
                            </li>
                          ))}
                        </ul>
                      </Section>

                      <Section label="PRODUCTION ESTIMATE">
                        <div className="font-mono text-[11px] leading-5 text-[#9AA3C0]">
                          {Object.keys(selected.production_estimate).length === 0
                            ? "not provided"
                            : Object.entries(selected.production_estimate).map(([k, v]) => `${k}: ${String(v)}`).join(" · ")}
                        </div>
                      </Section>
                    </div>
                  </div>
                </Card>

                {/* DECISIONS */}
                <Card>
                  <div className="label-mono mb-2 text-[#6B7594]">YOUR DECISION</div>
                  {selected.status === "submitted" ? (
                    <div className="space-y-3">
                      <textarea
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        rows={2}
                        placeholder="Optional note — what to change, or why you approve"
                        className="w-full rounded-xl border border-white/10 bg-[#070A14] px-3 py-2 text-[13px] text-white placeholder:text-zinc-500"
                      />
                      <div className="flex flex-wrap gap-2">
                        <button
                          disabled={busy !== null}
                          onClick={() =>
                            void run("approve", () => decideSeason(selected.id, "approved", note || undefined), `Approved '${selected.title}'. Production may now begin.`)
                          }
                          className="rounded-full bg-emerald-500 px-4 py-2 text-[13px] font-semibold text-black hover:bg-emerald-400 disabled:opacity-50"
                        >
                          {busy === "approve" ? "Saving…" : "Approve season"}
                        </button>
                        <button
                          disabled={busy !== null}
                          onClick={() =>
                            void run("changes", () => decideSeason(selected.id, "changes_requested", note || undefined), "Sent back to the Manager AI with your note.")
                          }
                          className="rounded-full border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-[13px] font-semibold text-amber-200 hover:bg-amber-500/20 disabled:opacity-50"
                        >
                          Request changes
                        </button>
                        <button
                          disabled={busy !== null}
                          onClick={() =>
                            void run("reject", () => decideSeason(selected.id, "rejected", note || undefined), "Rejected. No production will run for this season.")
                          }
                          className="rounded-full border border-red-500/40 bg-red-500/10 px-4 py-2 text-[13px] font-semibold text-red-200 hover:bg-red-500/20 disabled:opacity-50"
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  ) : selected.status === "approved" ? (
                    <div className="text-[13px] leading-6 text-[#9AA3C0]">
                      Approved by <span className="text-white">{selected.decided_by ?? "—"}</span> on{" "}
                      {formatDateTime(selected.decided_at)}. An approved season is the production contract — to change the
                      story, draft and submit a new season.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="text-[13px] leading-6 text-[#9AA3C0]">
                        {selected.status === "draft"
                          ? "This package is still a draft. When it is complete, send it for review — production stays blocked until you approve it."
                          : "The Manager AI has your feedback. It revises the package and resubmits."}
                        {selected.decision_note && (
                          <div className="mt-2 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2 text-[12px] text-white">
                            Your last note: {selected.decision_note}
                          </div>
                        )}
                      </div>
                      <button
                        disabled={busy !== null || selected.episodes.length === 0}
                        onClick={() =>
                          void run("submit", () => submitSeason(selected.id), "Submitted — it is now waiting for your decision.")
                        }
                        className="rounded-full bg-[#FF4D5A] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#ff5e6a] disabled:opacity-50"
                      >
                        {busy === "submit" ? "Submitting…" : "Submit for review"}
                      </button>
                      {selected.episodes.length === 0 && (
                        <div className="text-[12px] text-amber-300/90">A season needs at least one episode before it can be submitted.</div>
                      )}
                    </div>
                  )}
                </Card>

                <Card>
                  <div className="label-mono mb-2 text-[#6B7594]">DRAFT A PACKAGE (manual)</div>
                  <div className="text-[12px] leading-5 text-[#9AA3C0]">
                    Normally the Manager AI writes this package. You can also record one you drafted yourself — it goes
                    through the identical validation and the identical approval gate.
                  </div>
                  <button
                    disabled={busy !== null || !projectId}
                    onClick={() =>
                      void run(
                        "create",
                        () => createSeason(projectId, { ...EMPTY_PACKAGE, title: `Manual draft — ${new Date().toLocaleDateString()}`, arcs: ["to be defined"] }),
                        "Draft season created."
                      )
                    }
                    className="mt-3 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-[13px] font-semibold text-white hover:bg-white/10 disabled:opacity-50"
                  >
                    Create draft package
                  </button>
                </Card>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label-mono mb-1 text-[#6B7594]">{label}</div>
      {children}
    </div>
  );
}
