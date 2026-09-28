"use client";

import { useEffect, useState } from "react";
import { isBackendConfigured } from "@/lib/api";
import {
  PROVIDER_LABELS,
  PROVIDER_ORDER,
  fetchHealth,
  heartbeatAgeLabel,
  statusLabel,
  statusTone,
  type HealthReport,
  type ProviderHealth,
  type StatusTone,
} from "@/lib/health";

const TONE_CLASS: Record<StatusTone, { pill: string; dot: string; card: string }> = {
  ok: { pill: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30", dot: "bg-emerald-400", card: "border-emerald-500/20 bg-emerald-500/[0.06]" },
  info: { pill: "bg-sky-500/15 text-sky-300 border-sky-500/30", dot: "bg-sky-400 animate-pulse", card: "border-sky-500/20 bg-sky-500/[0.06]" },
  warn: { pill: "bg-amber-500/15 text-amber-300 border-amber-500/30", dot: "bg-amber-400", card: "border-amber-500/20 bg-amber-500/[0.06]" },
  bad: { pill: "bg-red-500/15 text-red-300 border-red-500/30", dot: "bg-red-400", card: "border-red-500/20 bg-red-500/[0.07]" },
  muted: { pill: "bg-white/[0.06] text-zinc-300 border-white/10", dot: "bg-zinc-400", card: "border-white/[0.06] bg-white/[0.03]" },
};

type Row = { key: string; label: string; subtitle: string; health: ProviderHealth };

function RowCard({ row, compact }: { row: Row; compact?: boolean }) {
  const tone = statusTone(row.health.status);
  const c = TONE_CLASS[tone];
  return (
    <div className={`rounded-2xl border ${c.card} ${compact ? "p-3" : "p-3.5"}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 leading-tight">
          <div className="truncate text-[12px] font-bold tracking-wide text-white">{row.label}</div>
          <div className="truncate text-[11px] text-[#6B7594]">{row.subtitle}</div>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-wide ${c.pill}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
          {statusLabel(row.health.status)}
        </span>
      </div>
      {row.health.reason && (
        <div className="mt-2 text-[11px] leading-4 text-[#9AA3C0]">{row.health.reason}</div>
      )}
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-[#6B7594]">
        {typeof row.health.latencyMs === "number" && <span>{row.health.latencyMs}ms</span>}
        {row.health.lastHeartbeatAt !== undefined && (
          <span>heartbeat {heartbeatAgeLabel(row.health.lastHeartbeatAt)}</span>
        )}
        {row.health.checkedAt && <span>{new Date(row.health.checkedAt).toLocaleTimeString()}</span>}
      </div>
    </div>
  );
}

export function ProviderStatus({
  compact = false,
  pollMs = 15_000,
  className = "",
}: {
  compact?: boolean;
  pollMs?: number;
  className?: string;
}) {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const configured = isBackendConfigured();

  useEffect(() => {
    let alive = true;
    async function load() {
      const r = await fetchHealth();
      if (!alive) return;
      if (r.reachable) {
        setReport(r.data);
        setUnreachable(null);
      } else {
        setUnreachable(r.error);
        setReport(null);
      }
      setLoading(false);
    }
    load();
    if (pollMs > 0) {
      const iv = setInterval(load, pollMs);
      return () => {
        alive = false;
        clearInterval(iv);
      };
    }
    return () => {
      alive = false;
    };
  }, [pollMs]);

  // 1) Frontend has no backend URL at all — NOT a provider failure.
  if (!configured) {
    return (
      <div className={`rounded-2xl border border-amber-500/25 bg-amber-500/10 p-3.5 ${className}`}>
        <div className="flex items-center gap-2 text-[12px] font-bold tracking-wide text-amber-200">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> RENDER API · NOT_CONFIGURED
        </div>
        <p className="mt-1.5 text-[12px] leading-5 text-amber-200/80">
          This deployment has no <span className="font-mono">NEXT_PUBLIC_API_URL</span>. Set it to{" "}
          <span className="font-mono">https://ostra-studio-1.onrender.com</span> in Vercel (Production) so the
          dashboard can read real worker state.
        </p>
      </div>
    );
  }

  // 2) Backend unreachable — distinct from any provider state.
  if (unreachable) {
    return (
      <div className={`rounded-2xl border border-red-500/25 bg-red-500/10 p-3.5 ${className}`}>
        <div className="flex items-center gap-2 text-[12px] font-bold tracking-wide text-red-200">
          <span className="h-1.5 w-1.5 rounded-full bg-red-400" /> BACKEND OFFLINE
        </div>
        <p className="mt-1.5 text-[12px] leading-5 text-red-200/85">
          Unable to reach Render API. No provider state is shown because none could be verified.
        </p>
        <p className="mt-1 break-all font-mono text-[10px] text-red-300/70">Connection error: {unreachable}</p>
      </div>
    );
  }

  if (loading && !report) {
    return <div className={`text-[12px] text-[#6B7594] ${className}`}>Reading live backend state…</div>;
  }
  if (!report) {
    return <div className={`text-[12px] text-[#6B7594] ${className}`}>No health data.</div>;
  }

  const backendHealth: ProviderHealth = {
    ok: report.status === "ONLINE",
    status: (report.status as ProviderHealth["status"]) ?? (report.ok ? "ONLINE" : "DEGRADED"),
    provider: "render-api",
    checkedAt: report.timestamp ?? report.at ?? new Date().toISOString(),
    reason:
      report.status === "ONLINE"
        ? `${report.app ?? "ostra-api"} on ${report.host ?? "render"} — responding`
        : report.ok
          ? "reachable but degraded"
          : undefined,
  };

  const rows: Row[] = [
    { key: "render", label: "Render API", subtitle: "scheduler + runtime supervisor", health: backendHealth },
  ];
  if (report.supabase) {
    rows.push({ key: "supabase", label: "Supabase", subtitle: "Postgres + Storage (source of truth)", health: report.supabase });
  }
  const providers = report.providers ?? {};
  for (const id of PROVIDER_ORDER) {
    const entry = providers[id];
    if (!entry) continue;
    rows.push({
      key: id,
      label: PROVIDER_LABELS[id] ?? entry.provider,
      subtitle: entry.provider + (entry.runtime ? ` · ${entry.runtime}` : ""),
      health: entry.health,
    });
  }

  return (
    <div className={className}>
      <div className={`grid gap-2 ${compact ? "sm:grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-3"}`}>
        {rows.map((row) => (
          <RowCard key={row.key} row={row} compact={compact} />
        ))}
      </div>
      <div className="mt-2 text-[10px] leading-4 text-[#6B7594]">
        Live from <span className="font-mono">GET /api/health</span> · <span className="font-mono">ONLINE</span> requires a
        real heartbeat or a real check — configuration alone is never ONLINE.
      </div>
    </div>
  );
}
