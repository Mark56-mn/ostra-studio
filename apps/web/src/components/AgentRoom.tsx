"use client";

import { Badge, statusVariant } from "./ui/Badge";
import { Card, CardHeader } from "./ui/Card";
import { heartbeatAgeLabel, statusLabel } from "@/lib/health";

export type AgentRow = {
  id: string;
  type: "script" | "image" | "voice" | "video" | "youtube" | string;
  provider: string;
  model?: string | null;
  runtime?: string | null;
  status: string; // raw WorkerStatus from Supabase
  /** Server-derived health (heartbeat-derived). When present, this wins over `status`. */
  health?: { status: string; reason?: string; heartbeatAgeSec?: number | null } | null;
  lastHeartbeatAt?: string | null;
  error?: string | null;
  currentTaskId?: string | null;
  endpoint?: string | null;
  heartbeatTimeoutSec?: number | null;
  registeredAt?: string | null;
};

const TYPE_META: Record<string, { label: string; icon: string; hint: string }> = {
  script: { label: "SCRIPT AI", icon: "✎", hint: "Kaggle" },
  image: { label: "IMAGE AI", icon: "◈", hint: "Colab" },
  voice: { label: "VOICE AI", icon: "◐", hint: "Kokoro-82M" },
  video: { label: "VIDEO ENGINE", icon: "▶", hint: "FFmpeg" },
  youtube: { label: "YOUTUBE", icon: "▲", hint: "API" },
};

export function AgentRoom({ agents, onProbe }: { agents: AgentRow[]; onProbe?: (id: string) => void }) {
  return (
    <Card>
      <CardHeader
        kicker="AGENT ROOM — REAL STATE"
        title="Production workers"
        action={<span className="label-mono hidden text-[#6B7594] sm:inline">heartbeat ≠ task • no mock mode</span>}
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((a) => {
          const meta = TYPE_META[a.type] ?? { label: String(a.type).toUpperCase(), icon: "•", hint: a.runtime ?? "" };
          const effective = a.health?.status ?? a.status;
          const v = statusVariant(effective);
          const reason = a.health?.reason ?? a.error ?? null;
          return (
            <div key={a.id} className="rounded-2xl border border-white/[0.06] bg-[#0F1425] p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/[0.06] text-[12px] font-bold text-white">
                    {meta.icon}
                  </div>
                  <div className="leading-tight">
                    <div className="text-[12px] font-bold tracking-wide text-white">{meta.label}</div>
                    <div className="text-[11px] text-[#6B7594]">
                      {a.provider}
                      {a.model ? ` · ${a.model}` : ""}
                    </div>
                  </div>
                </div>
                <Badge variant={v} dot>
                  {statusLabel(effective)}
                </Badge>
              </div>
              <div className="mt-3 space-y-1 text-[12px] leading-relaxed">
                <div className="flex justify-between">
                  <span className="text-[#6B7594]">Runtime</span>
                  <span className="font-medium text-zinc-200">{a.runtime ?? meta.hint}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#6B7594]">Heartbeat</span>
                  <span className="font-mono text-[11px] text-zinc-300">{heartbeatAgeLabel(a.lastHeartbeatAt)}</span>
                </div>
                {a.currentTaskId && (
                  <div className="truncate font-mono text-[11px] text-sky-300">task {a.currentTaskId.slice(0, 8)}…</div>
                )}
                {reason && (
                  <div className="rounded-lg bg-white/[0.04] px-2 py-1.5 text-[11px] leading-snug text-[#9AA3C0]">
                    {reason}
                  </div>
                )}
                {a.status !== effective && (
                  <div className="font-mono text-[10px] text-[#6B7594]">db status: {a.status}</div>
                )}
              </div>
              {onProbe && (
                <button
                  onClick={() => onProbe(a.id)}
                  className="mt-3 w-full rounded-full border border-white/10 bg-white/[0.04] py-2 text-[12px] font-medium text-zinc-200 hover:bg-white/10"
                >
                  Probe health
                </button>
              )}
            </div>
          );
        })}
      </div>
      {agents.length === 0 && (
        <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-8 text-center text-sm text-[#6B7594]">
          No workers registered yet. A runtime becomes visible here only after it calls{" "}
          <span className="font-mono text-zinc-300">POST /api/workers/register</span> and starts heartbeating. Worker
          status is never assumed.
        </div>
      )}
    </Card>
  );
}
