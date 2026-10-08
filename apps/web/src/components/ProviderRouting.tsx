"use client";
// apps/web/src/components/ProviderRouting.tsx
// The switch the director asked for: flip every agent onto NVIDIA's free models, or back onto the
// project's own runtimes. Nothing here is optimistic — each change is sent to the backend, persisted
// and audited, and the panel re-renders from the backend's answer.

import { useCallback, useEffect, useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { statusLabel, statusTone, type StatusTone } from "@/lib/health";
import {
  ROUTING_MODE_HINT,
  ROUTING_MODE_LABEL,
  SLOT_LABEL,
  fetchRouting,
  saveRouting,
  slotAnswerLabel,
  slotOverride,
  type RoutingMode,
  type RoutingView,
  type RoutableSlot,
} from "@/lib/routing";

const MODES: RoutingMode[] = ["own", "auto", "nvidia"];
const SLOTS: RoutableSlot[] = ["manager", "script", "image", "voice", "overseer"];

const TONE_PILL: Record<StatusTone, string> = {
  ok: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  info: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  warn: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  bad: "bg-red-500/15 text-red-300 border-red-500/30",
  muted: "bg-white/[0.06] text-zinc-300 border-white/10",
};

export function ProviderRouting() {
  const [view, setView] = useState<RoutingView | null>(null);
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetchRouting();
    if (r.ok) {
      setView(r.data);
      setUnreachable(null);
    } else {
      setUnreachable(r.error);
      setView(null);
    }
  }, []);

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 15_000);
    return () => clearInterval(iv);
  }, [load]);

  async function apply(patch: Parameters<typeof saveRouting>[0], label: string) {
    setBusy(label);
    setErr(null);
    setNotice(null);
    const r = await saveRouting(patch);
    if (!r.ok) setErr(r.error);
    else {
      setView(r.data);
      setNotice(`${label} — saved and audited as routing.changed`);
    }
    setBusy(null);
  }

  const nv = view?.nvidia;
  const nvTone = nv ? statusTone(nv.health?.status) : "muted";

  return (
    <Card>
      <CardHeader
        kicker="PROVIDER ROUTING — WHICH MODEL ANSWERS"
        title="Own models, NVIDIA free models, or both"
        action={
          <button
            onClick={() => void load()}
            className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-medium text-white hover:bg-white/10"
          >
            Refresh
          </button>
        }
      />

      {unreachable && (
        <div className="mb-3 rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-[13px] text-red-200">
          <span className="font-semibold">ROUTING UNAVAILABLE</span> — {unreachable}. No mode is shown because none
          could be read. Check the Render API and run{" "}
          <span className="font-mono">supabase/migrations/009_provider_routing.sql</span>.
        </div>
      )}
      {err && <div className="mb-3 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-200">{err}</div>}
      {notice && <div className="mb-3 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-[13px] text-emerald-200">{notice}</div>}

      {view && (
        <>
          <div className="grid gap-2 sm:grid-cols-3">
            {MODES.map((m) => {
              const active = view.settings.mode === m;
              return (
                <button
                  key={m}
                  disabled={busy !== null}
                  onClick={() => void apply({ mode: m }, `Routing mode → ${ROUTING_MODE_LABEL[m]}`)}
                  className={`rounded-2xl border px-3 py-3 text-left transition disabled:opacity-60 ${
                    active ? "border-[#3DE0B3]/50 bg-[#3DE0B3]/10" : "border-white/[0.07] bg-[#0F1425] hover:bg-white/[0.05]"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${active ? "bg-[#3DE0B3]" : "bg-zinc-600"}`} />
                    <span className="text-[13px] font-semibold text-white">{ROUTING_MODE_LABEL[m]}</span>
                  </div>
                  <p className="mt-1 text-[11px] leading-4 text-[#9AA3C0]">{ROUTING_MODE_HINT[m]}</p>
                </button>
              );
            })}
          </div>

          {view.settings.mode === "nvidia" && !nv?.configured && (
            <div className="mt-3 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-[13px] leading-5 text-amber-200">
              <span className="font-semibold">NVIDIA IS NOT CONFIGURED.</span> Every agent is routed to it, so no agent
              can answer until <span className="font-mono text-[12px]">NVIDIA_API_KEY</span> is set on the backend.{" "}
              {nv && <span>{nv.reason}</span>}
            </div>
          )}

          <div className="mt-3 rounded-2xl border border-white/[0.07] bg-[#131A32]/70 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="label-mono text-[#6B7594]">NVIDIA NIM BACKUP</span>
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold tracking-wide ${TONE_PILL[nvTone]}`}>
                <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
                {nv?.configured ? `PROBE ${statusLabel(nv.health?.status)}` : "NOT CONFIGURED"}
              </span>
              {nv?.thinking && (
                <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 text-[10px] font-bold tracking-wide text-sky-300">
                  THINKING REQUESTED
                </span>
              )}
            </div>
            <div className="mt-2 grid gap-1 font-mono text-[11px] text-[#8B94B4]">
              <div>model: {nv?.model ?? "—"}</div>
              <div>endpoint host: {nv?.host ?? "—"}</div>
              {nv?.health && (
                <div>
                  probe: {statusLabel(nv.health.status)} — {nv.health.reason ?? "no reason reported"}
                  {nv.health.latencyMs != null ? ` (${nv.health.latencyMs}ms)` : ""}
                </div>
              )}
              {!nv?.configured && <div>{nv?.reason ?? "NVIDIA_API_KEY is not set on the backend"}</div>}
            </div>
            <p className="mt-2 text-[11px] leading-4 text-[#6B7594]">
              The probe is one real completion call, cached about a minute. A key being present is never reported as
              ONLINE — a call has to actually succeed. Model ids are restricted to a vetted catalog, and the key is only
              ever sent to an allowlisted NVIDIA host.
            </p>
          </div>

          <div className="mt-3 overflow-hidden rounded-2xl border border-white/[0.07]">
            <table className="w-full text-left">
              <thead className="bg-white/[0.03]">
                <tr>
                  <th className="px-3 py-2 label-mono text-[#6B7594]">AGENT</th>
                  <th className="px-3 py-2 label-mono text-[#6B7594]">MODE</th>
                  <th className="px-3 py-2 label-mono text-[#6B7594]">ANSWERS FROM</th>
                </tr>
              </thead>
              <tbody>
                {SLOTS.map((slot) => {
                  const row = view.slots.find((s) => s.slot === slot);
                  return (
                    <tr key={slot} className="border-t border-white/[0.05] align-top">
                      <td className="px-3 py-2">
                        <div className="text-[13px] font-semibold text-white">{SLOT_LABEL[slot]}</div>
                        <div className="font-mono text-[10px] text-[#6B7594]">
                          {row?.model ?? "no model"} · {row?.endpointHost ?? "no endpoint"}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={slotOverride(view.settings, slot)}
                          disabled={busy !== null}
                          onChange={(e) => {
                            const value = e.target.value;
                            void apply(
                              { slot, slotMode: value === "" ? null : (value as RoutingMode) },
                              `${SLOT_LABEL[slot]} → ${value === "" ? "inherit" : ROUTING_MODE_LABEL[value as RoutingMode]}`
                            );
                          }}
                          className="rounded-lg border border-white/10 bg-[#070A14] px-2 py-1 text-[12px] text-white disabled:opacity-60"
                        >
                          <option value="">Inherit ({ROUTING_MODE_LABEL[view.settings.mode]})</option>
                          {MODES.map((m) => (
                            <option key={m} value={m}>
                              {ROUTING_MODE_LABEL[m]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <div className="text-[12px] leading-4 text-[#C7CEE4]">{row ? slotAnswerLabel(row) : "unknown"}</div>
                        <div className="mt-0.5 text-[11px] leading-4 text-[#6B7594]">{row?.detail ?? "the backend reported no route for this slot"}</div>
                        {row?.available && row.kind === "project_worker" && (
                          <div className="mt-0.5 font-mono text-[10px] text-[#4C5570]">reachable now</div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[#6B7594]">
            <span>
              {view.settings.updatedAt
                ? `last changed ${new Date(view.settings.updatedAt).toLocaleString()}${view.settings.updatedBy ? ` by ${view.settings.updatedBy}` : ""}`
                : "never changed — default: auto"}
            </span>
            <span>persisted in <span className="font-mono text-white">provider_routing</span> (single row)</span>
            <span>audited as <span className="font-mono text-white">routing.changed</span></span>
            {view.read_reason && <span className="text-amber-300">read problem: {view.read_reason} — falling back to auto</span>}
          </div>

          <div className="mt-3 rounded-xl border border-white/[0.06] bg-[#070A14]/60 px-3 py-2">
            <div className="label-mono mb-1 text-[#6B7594]">NVIDIA CATALOG — THE ONLY DISPATCHABLE IDS</div>
            <ul className="grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
              {nv?.catalog.map((m) => (
                <li key={m.id} className="text-[11px] leading-4 text-[#9AA3C0]">
                  <span className="font-mono text-[10px] text-white">{m.id}</span>
                  {m.thinking ? <span className="ml-1 text-sky-300">· thinking</span> : null}
                  <div className="text-[10px] text-[#6B7594]">{m.note}</div>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[11px] leading-4 text-[#6B7594]">
              Pick one per agent with <span className="font-mono text-white">NVIDIA_MODEL_&lt;SLOT&gt;</span> on the
              backend, or set <span className="font-mono text-white">NVIDIA_CHAT_MODEL</span> for all of them. An id
              that is not on this list is refused instead of being forwarded.
            </p>
          </div>
        </>
      )}

      {view === null && !unreachable && <div className="py-6 text-center text-[13px] text-[#6B7594]">Reading routing state…</div>}
      {busy && <div className="mt-2 text-[11px] text-[#6B7594]">Saving {busy}…</div>}
    </Card>
  );
}
