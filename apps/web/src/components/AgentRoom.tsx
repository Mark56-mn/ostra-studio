"use client";

import { Badge, statusVariant } from "./ui/Badge";
import { Card, CardHeader } from "./ui/Card";

export type AgentRow = {
  id: string;
  type: "script" | "image" | "voice" | "video" | "youtube";
  provider: string;
  model?: string | null;
  runtime?: string | null;
  status: string; // WorkerStatus
  lastHeartbeatAt?: string | null;
  error?: string | null;
  currentTaskId?: string | null;
};

const TYPE_META: Record<AgentRow["type"], { label: string; icon: string; hint: string }> = {
  script:  { label: "SCRIPT AI",  icon: "✎", hint: "Kaggle" },
  image:   { label: "IMAGE AI",   icon: "◈", hint: "Colab" },
  voice:   { label: "VOICE AI",   icon: "◐", hint: "Kokoro-82M" },
  video:   { label: "VIDEO ENGINE", icon: "▶", hint: "FFmpeg" },
  youtube: { label: "YOUTUBE",    icon: "▲", hint: "API" },
};

function heartbeatAge(iso?: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 15_000) return "just now";
  if (ms < 60_000) return `${Math.round(ms/1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms/60000)}m ago`;
  return new Date(iso).toLocaleTimeString();
}

export function AgentRoom({ agents, onProbe }: { agents: AgentRow[]; onProbe?: (id: string) => void }) {
  return (
    <Card>
      <CardHeader kicker="AGENT ROOM — REAL STATE" title="Production workers" action={
        <span className="label-mono hidden text-[#6B7594] sm:inline">heartbeat ≠ task • no mock mode</span>
      } />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((a) => {
          const meta = TYPE_META[a.type] ?? { label: a.type.toUpperCase(), icon: "•", hint: a.runtime ?? "" };
          const v = statusVariant(a.status);
          return (
            <div key={a.id} className="rounded-2xl border border-white/[0.06] bg-[#0F1425] p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/[0.06] text-[12px] font-bold text-white">{meta.icon}</div>
                  <div className="leading-tight">
                    <div className="text-[12px] font-bold tracking-wide text-white">{meta.label}</div>
                    <div className="text-[11px] text-[#6B7594]">{a.provider}{a.model ? ` · ${a.model}` : ""}</div>
                  </div>
                </div>
                <Badge variant={v} dot>{a.status}</Badge>
              </div>
              <div className="mt-3 space-y-1 text-[12px] leading-relaxed">
                <div className="flex justify-between"><span className="text-[#6B7594]">Runtime</span><span className="font-medium text-zinc-200">{a.runtime ?? meta.hint}</span></div>
                <div className="flex justify-between"><span className="text-[#6B7594]">Heartbeat</span><span className="font-mono text-[11px] text-zinc-300">{heartbeatAge(a.lastHeartbeatAt)}</span></div>
                {a.currentTaskId && <div className="truncate font-mono text-[11px] text-sky-300">task {a.currentTaskId.slice(0,8)}…</div>}
                {a.error && <div className="rounded-lg bg-red-500/10 px-2 py-1.5 text-[11px] leading-snug text-red-200">{a.error}</div>}
              </div>
              {onProbe && (
                <button onClick={() => onProbe(a.id)} className="mt-3 w-full rounded-full border border-white/10 bg-white/[0.04] py-2 text-[12px] font-medium text-zinc-200 hover:bg-white/10">
                  Probe health
                </button>
              )}
            </div>
          );
        })}
      </div>
      {agents.length === 0 && (
        <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-8 text-center text-sm text-[#6B7594]">
          No workers registered yet. The orchestrator is waiting for the first heartbeat.
        </div>
      )}
    </Card>
  );
}

// Static fallback for when Supabase isn't configured — still shows the real OFFLINE state.
export const OFFLINE_AGENTS: AgentRow[] = [
  { id: "offline-script",  type: "script",  provider: "kaggle",        runtime: "kaggle", status: "OFFLINE", error: "Set KAGGLE_SCRIPT_URL to connect" },
  { id: "offline-image",   type: "image",   provider: "colab-image",   runtime: "colab",  status: "OFFLINE", error: "Set COLAB_IMAGE_URL to connect" },
  { id: "offline-voice",   type: "voice",   provider: "kokoro-82m",    runtime: "colab",  status: "OFFLINE", error: "Set KOKORO_VOICE_URL to connect" },
  { id: "offline-video",   type: "video",   provider: "ffmpeg",        runtime: "local",  status: "OFFLINE", error: "Phase 7 — local worker" },
  { id: "offline-youtube", type: "youtube", provider: "youtube-api",   runtime: "api",    status: "OFFLINE", error: "YouTube OAuth pending — Phase 9" },
];
