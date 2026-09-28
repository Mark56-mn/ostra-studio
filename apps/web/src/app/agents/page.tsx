"use client";

import { useCallback, useEffect, useState } from "react";
import { TopNav } from "@/components/TopNav";
import { AgentRoom, type AgentRow } from "@/components/AgentRoom";
import { ProviderStatus } from "@/components/ProviderStatus";
import { Card } from "@/components/ui/Card";
import { fetchHealth, fetchWorkers, type WorkerRow } from "@/lib/health";

function toAgent(w: WorkerRow): AgentRow {
  return {
    id: String(w.id),
    type: String(w.type),
    provider: String(w.provider),
    model: w.model ?? null,
    runtime: w.runtime ?? null,
    status: String(w.status),
    health: w.health ? { status: w.health.status, reason: w.health.reason, heartbeatAgeSec: w.health.heartbeatAgeSec } : null,
    lastHeartbeatAt: w.last_heartbeat_at ?? null,
    error: w.error_message ?? w.error ?? null,
    currentTaskId: w.current_task_id ?? null,
    endpoint: w.endpoint ?? null,
  };
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const r = await fetchWorkers();
      setReachable(r.reachable);
      setErr(r.error ?? null);
      setAgents(r.workers.map(toAgent));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 15_000);
    return () => clearInterval(iv);
  }, [refresh]);

  return (
    <div className="min-h-screen bg-[#070A14]">
      <TopNav />
      <main className="mx-auto max-w-[1100px] space-y-4 px-4 py-6 sm:px-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="label-mono text-[#6B7594]">ORCHESTRATOR — REAL STATE</div>
            <h1 className="text-[22px] font-bold tracking-tight text-white">Agent Room</h1>
            <p className="max-w-[62ch] text-[13px] leading-5 text-[#9AA3C0]">
              Every status below comes from the Render API. A worker is <span className="text-white">ONLINE</span> only
              while it has a fresh heartbeat; the orchestrator never assumes a worker exists.
            </p>
          </div>
          <button
            onClick={refresh}
            disabled={checking}
            className="shrink-0 rounded-full bg-white px-4 py-2 text-[13px] font-semibold text-[#070A14] disabled:opacity-60"
          >
            {checking ? "Checking…" : "Probe all"}
          </button>
        </div>

        {reachable === false && (
          <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-[13px] text-red-200">
            <span className="font-semibold">BACKEND OFFLINE.</span> Unable to reach the Render API — no worker state is
            shown because none could be verified.
            {err && <span className="ml-1 break-all font-mono text-[11px] text-red-300/80">({err})</span>}
          </div>
        )}
        {reachable === true && err && (
          <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-200">
            Worker registry responded but reported a problem: <span className="font-mono text-[12px]">{err}</span>
          </div>
        )}

        <AgentRoom agents={agents} />

        <Card>
          <div className="label-mono mb-2 text-[#6B7594]">PROVIDER HEALTH — LIVE FROM RENDER</div>
          <ProviderStatus />
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
  const [data, setData] = useState<string>("…");
  useEffect(() => {
    let alive = true;
    fetchHealth().then((r) => {
      if (!alive) return;
      setData(r.reachable ? JSON.stringify(r.data, null, 2) : `Render API unreachable: ${r.error}`);
    });
    return () => {
      alive = false;
    };
  }, []);
  return (
    <pre className="overflow-auto rounded-xl bg-[#070A14] p-3 font-mono text-[11px] leading-5 text-zinc-300">{data}</pre>
  );
}
