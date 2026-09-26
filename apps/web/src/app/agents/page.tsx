"use client";
import { apiUrl } from "@/lib/api";
import { useEffect, useState } from "react";
import { TopNav } from "@/components/TopNav";
import { AgentRoom, OFFLINE_AGENTS, type AgentRow } from "@/components/AgentRoom";
import { Card } from "@/components/ui/Card";

type HealthResp = Record<string, { provider?: string; health?: { ok:boolean; status:string; reason?:string; latencyMs?:number; checkedAt?:string } }>;

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentRow[]>(OFFLINE_AGENTS);
  const [health, setHealth] = useState<HealthResp | null>(null);
  const [checking, setChecking] = useState(false);

  async function refresh() {
    setChecking(true);
    try {
      const [w, h] = await Promise.all([fetch(apiUrl("/api/workers")).then(r=>r.json()), fetch(apiUrl("/api/providers")).then(r=>r.json())]);
      if (w.workers) {
        setAgents(w.workers.map((x: Record<string,unknown>)=>({
          id: String(x["id"]), type: String(x["type"]) as AgentRow["type"],
          provider: String(x["provider"]), model: (x["model"] as string) ?? null,
          runtime: (x["runtime"] as string) ?? null, status: String(x["status"]),
          lastHeartbeatAt: (x["last_heartbeat_at"] as string) ?? null, error: (x["error"] as string) ?? null,
        })));
      }
      setHealth(h);
    } finally { setChecking(false); }
  }
  useEffect(()=>{ refresh(); }, []);

  return (
    <div className="min-h-screen bg-[#070A14]">
      <TopNav />
      <main className="mx-auto max-w-[1100px] space-y-4 px-4 py-6 sm:px-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="label-mono text-[#6B7594]">ORCHESTRATOR — REAL STATE</div>
            <h1 className="text-[22px] font-bold tracking-tight text-white">Agent Room</h1>
            <p className="max-w-[60ch] text-[13px] leading-5 text-[#9AA3C0]">Heartbeat is not a task. A worker can be ONLINE with no work, or OFFLINE with queued tasks waiting. The orchestrator never fakes a result.</p>
          </div>
          <button onClick={refresh} disabled={checking} className="shrink-0 rounded-full bg-white px-4 py-2 text-[13px] font-semibold text-[#070A14] disabled:opacity-60">
            {checking ? "Checking…" : "Probe all"}
          </button>
        </div>

        <AgentRoom agents={agents} />

        <Card>
          <div className="label-mono mb-2 text-[#6B7594]">PROVIDER HEALTH — live probe</div>
          {!health ? (
            <div className="text-sm text-[#6B7594]">Probing…</div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {Object.entries(health).map(([k, v])=> {
                const h = v.health;
                const ok = h?.ok;
                return (
                  <div key={k} className={`rounded-xl border px-3 py-3 ${ok ? "border-emerald-500/20 bg-emerald-500/10" : "border-white/[0.06] bg-white/[0.03]"}`}>
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] font-bold tracking-wide text-white">{k.toUpperCase()} · {v.provider ?? "—"}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${ok ? "bg-emerald-500 text-white" : "bg-white/10 text-zinc-300"}`}>{h?.status ?? "UNKNOWN"}</span>
                    </div>
                    {h?.reason && <div className="mt-1 text-[12px] leading-5 text-[#9AA3C0]">{h.reason}</div>}
                    <div className="mt-1 flex gap-3 font-mono text-[11px] text-[#6B7594]">
                      {typeof h?.latencyMs === "number" && <span>{h.latencyMs}ms</span>}
                      {h?.checkedAt && <span>{new Date(h.checkedAt).toLocaleTimeString()}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="mt-3 rounded-xl bg-[#0F1425] p-3 text-[12px] leading-5 text-[#6B7594]">
            Configure <span className="font-mono text-white">KAGGLE_SCRIPT_URL</span>, <span className="font-mono text-white">COLAB_IMAGE_URL</span>, <span className="font-mono text-white">KOKORO_VOICE_URL</span> (or <span className="font-mono text-white">COLAB_VOICE_URL</span>) in your environment to turn workers ONLINE. No code change needed — adapters probe the URL and report real health.
          </div>
        </Card>

        <Card>
          <div className="label-mono mb-2 text-[#6B7594]">RAW — /api/health</div>
          <HealthDump />
        </Card>
      </main>
    </div>
  );
}

function HealthDump() {
  const [data, setData] = useState<unknown>(null);
  useEffect(()=>{ fetch(apiUrl("/api/health")).then(r=>r.json()).then(setData).catch(()=>{}); }, []);
  return <pre className="overflow-auto rounded-xl bg-[#070A14] p-3 font-mono text-[11px] leading-5 text-zinc-300">{data ? JSON.stringify(data, null, 2) : "…"}</pre>;
}
