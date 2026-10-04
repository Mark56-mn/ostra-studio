"use client";
import { useCallback, useEffect, useState } from "react";
import { TopNav } from "@/components/TopNav";
import { Card, CardHeader } from "@/components/ui/Card";
import { heartbeatAgeLabel, statusLabel, statusTone, type StatusTone } from "@/lib/health";
import {
  DISPATCH_STYLE,
  dispatchLabel,
  fetchModels,
  setModelEnabled,
  type ModelView,
  type ModelCounts,
} from "@/lib/models";

const TONE_PILL: Record<StatusTone, string> = {
  ok: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  info: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  warn: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  bad: "bg-red-500/15 text-red-300 border-red-500/30",
  muted: "bg-white/[0.06] text-zinc-300 border-white/10",
};

function Switch({
  on,
  busy,
  label,
  onToggle,
}: {
  on: boolean;
  busy: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
      disabled={busy}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition disabled:opacity-60 ${
        on ? "border-emerald-500/40 bg-emerald-500/30" : "border-white/15 bg-white/[0.06]"
      }`}
    >
      <span
        className={`absolute h-[18px] w-[18px] rounded-full transition-transform ${
          on ? "translate-x-[22px] bg-emerald-300" : "translate-x-0.5 bg-zinc-400"
        }`}
      />
    </button>
  );
}

function ModelCard({
  model,
  busy,
  error,
  onToggle,
}: {
  model: ModelView;
  busy: boolean;
  error?: string;
  onToggle: (next: boolean) => void;
}) {
  const health = model.health;
  const tone = statusTone(health?.status);
  const dispatch = DISPATCH_STYLE[model.dispatch];
  return (
    <div
      className={`rounded-2xl border p-4 transition ${
        model.enabled ? "border-white/[0.08] bg-[#0F1425]" : "border-white/[0.04] bg-white/[0.02] opacity-90"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold tracking-tight text-white">{model.label}</div>
          <div className="mt-0.5 font-mono text-[11px] text-[#6B7594]">
            {model.provider} · {model.runtime} · {model.liveModel ?? "no model reported"}
          </div>
        </div>
        <Switch on={model.enabled} busy={busy} label={`Toggle ${model.label}`} onToggle={() => onToggle(!model.enabled)} />
      </div>

      <p className="mt-2 text-[12px] leading-5 text-[#9AA3C0]">{model.description}</p>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold tracking-wide ${TONE_PILL[tone]}`}>
          <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
          HEALTH {statusLabel(health?.status)}
        </span>
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold tracking-wide ${dispatch.pill}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${dispatch.dot}`} />
          {dispatchLabel(model.dispatch)}
        </span>
        <span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold tracking-wide ${model.enabled ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-white/10 bg-white/[0.04] text-zinc-400"}`}>
          SWITCH {model.enabled ? "ON" : "OFF"}
        </span>
      </div>

      {health?.reason && <div className="mt-2 text-[11px] leading-4 text-[#9AA3C0]">{health.reason}</div>}
      {model.liveModel && model.liveModel !== model.label.split("·").pop()?.trim() && (
        <div className="mt-1 text-[11px] leading-4 text-[#9AA3C0]">
          Live model reported by the worker: <span className="font-mono text-white">{model.liveModel}</span>
        </div>
      )}

      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-[#6B7594]">
        {health?.lastHeartbeatAt !== undefined && <span>heartbeat {heartbeatAgeLabel(health?.lastHeartbeatAt)}</span>}
        {typeof health?.latencyMs === "number" && <span>{health.latencyMs}ms</span>}
        <span>
          {model.updatedAt
            ? `switch changed ${new Date(model.updatedAt).toLocaleString()}${model.updatedBy ? ` by ${model.updatedBy}` : ""}`
            : "switch never changed — default ON"}
        </span>
      </div>
      {model.note && <div className="mt-1 text-[11px] italic text-[#6B7594]">note: {model.note}</div>}
      {error && <div className="mt-2 text-[11px] text-amber-300">{error}</div>}
    </div>
  );
}

export default function ModelsPage() {
  const [models, setModels] = useState<ModelView[] | null>(null);
  const [counts, setCounts] = useState<ModelCounts | null>(null);
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const r = await fetchModels();
    if (r.reachable) {
      setModels(r.models);
      setCounts(r.counts ?? null);
      setUnreachable(null);
      if (r.error) setErr(r.error);
    } else {
      setUnreachable(r.error ?? "unreachable");
      setModels(null);
    }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 15_000);
    return () => clearInterval(iv);
  }, [load]);

  async function toggle(model: ModelView, next: boolean) {
    setBusy(model.key);
    setRowErr((p) => ({ ...p, [model.key]: "" }));
    const r = await setModelEnabled(model.key, next);
    if (!r.ok) {
      setRowErr((p) => ({ ...p, [model.key]: r.error ?? "Toggle failed" }));
      setErr(r.error ?? "Toggle failed");
    } else {
      setErr(null);
      setNotice(`${model.label} switched ${next ? "ON" : "OFF"} — recorded in model_controls`);
      if (r.model) setModels((prev) => (prev ? prev.map((m) => (m.key === model.key ? r.model! : m)) : prev));
      else await load();
    }
    setBusy(null);
  }

  return (
    <div className="min-h-screen bg-[#070A14]">
      <TopNav />
      <main className="mx-auto max-w-[1100px] space-y-4 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="label-mono text-[#6B7594]">CONTROL PLANE — MODEL SWITCHES</div>
            <h1 className="text-[22px] font-bold tracking-tight text-white">AI Models</h1>
            <p className="max-w-[70ch] text-[13px] leading-6 text-[#9AA3C0]">
              Switch any AI model on or off. A model that is switched off is never started and never receives work —
              scheduler runs and <span className="font-mono text-white">Run Now</span> are refused and recorded as{" "}
              <span className="font-mono text-white">skipped_disabled</span>. Switching a model on does{" "}
              <span className="text-white">not</span> make it ONLINE: the health shown here is the same real
              heartbeat/check state reported everywhere else.
            </p>
          </div>
          <button
            onClick={load}
            className="rounded-full bg-white px-4 py-2 text-[13px] font-semibold text-[#070A14] hover:bg-zinc-100"
          >
            Refresh
          </button>
        </div>

        {unreachable && (
          <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-[13px] text-red-200">
            <span className="font-semibold">MODEL SWITCHES UNAVAILABLE</span> — {unreachable}. No switch state is shown
            because none could be verified. Check <span className="font-mono">SUPABASE_URL</span> /{" "}
            <span className="font-mono">SUPABASE_SERVICE_ROLE_KEY</span> on Render and run{" "}
            <span className="font-mono">supabase/migrations/004_model_controls.sql</span>.
          </div>
        )}
        {err && !unreachable && (
          <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-200">{err}</div>
        )}
        {notice && (
          <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-[13px] text-emerald-200">{notice}</div>
        )}

        {counts && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { k: "Models", v: counts.total },
              { k: "Switched on", v: counts.enabled },
              { k: "Switched off", v: counts.disabled },
              { k: "Dispatching now", v: counts.ready },
            ].map((s) => (
              <div key={s.k} className="rounded-2xl border border-white/[0.07] bg-[#131A32]/80 px-3 py-2.5">
                <div className="label-mono text-[#6B7594]">{s.k}</div>
                <div className="text-[20px] font-bold tracking-tight text-white">{s.v}</div>
              </div>
            ))}
          </div>
        )}

        <Card>
          <CardHeader kicker="MODELS" title="Switches" />
          {models === null ? (
            <div className="py-10 text-center text-sm text-[#6B7594]">
              {unreachable ? "No model state to show." : "Reading live model state…"}
            </div>
          ) : models.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-8 text-center text-sm text-[#6B7594]">
              The backend reported no switchable models.
            </div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {models.map((m) => (
                <ModelCard
                  key={m.key}
                  model={m}
                  busy={busy === m.key}
                  error={rowErr[m.key] || undefined}
                  onToggle={(next) => toggle(m, next)}
                />
              ))}
            </div>
          )}
          <div className="mt-3 text-[11px] leading-4 text-[#6B7594]">
            Persisted in <span className="font-mono text-white">model_controls</span> (Supabase) and audited as{" "}
            <span className="font-mono text-white">model.enabled</span> / <span className="font-mono text-white">model.disabled</span>{" "}
            events. Enforced in the runtime supervisor at <span className="font-mono text-white">/api/runtime/tick</span> and{" "}
            <span className="font-mono text-white">/api/runtime/run-now</span> — the only places an external runtime is started.
            The switch changes intent, never health.
          </div>
        </Card>
      </main>
    </div>
  );
}
