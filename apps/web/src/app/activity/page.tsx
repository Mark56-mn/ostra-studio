"use client";
import { apiUrl } from "@/lib/api";
import { useEffect, useState } from "react";
import { TopNav } from "@/components/TopNav";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";

type Evt = { id:string; type:string; actor?:string|null; payload?: Record<string,unknown>|null; created_at:string; task_id?:string|null; episode_id?:string|null };

export default function ActivityPage() {
  const [events, setEvents] = useState<Evt[]|null>(null);
  const [err, setErr] = useState<string|null>(null);
  async function load(){ const r=await fetch(apiUrl("/api/events?limit=80")); const j=await r.json(); if(!r.ok) setErr(j.error ?? "Failed"); else { setErr(null); setEvents(j.events);} }
  useEffect(()=>{ load(); const id=setInterval(load, 8000); return ()=>clearInterval(id); }, []);
  return (
    <div className="min-h-screen bg-[#070A14]">
      <TopNav />
      <main className="mx-auto max-w-[1100px] space-y-4 px-4 py-6 sm:px-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="label-mono text-[#6B7594]">AUDIT — IMMUTABLE</div>
            <h1 className="text-[22px] font-bold text-white">Activity</h1>
            <p className="text-[13px] text-[#9AA3C0]">Every important action is recorded. Polls every 8s — replace with Supabase Realtime when you connect it.</p>
          </div>
          <button onClick={load} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-[13px] font-medium text-white hover:bg-white/10">Refresh</button>
        </div>
        {err && <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-200">{err} — {err.includes("Supabase") ? "Set NEXT_PUBLIC_SUPABASE_URL + keys and run the migration." : ""}</div>}
        <Card>
          <CardHeader kicker="EVENT STREAM" title={`${events?.length ?? 0} events`} />
          {!events ? <div className="py-8 text-center text-sm text-[#6B7594]">Loading…</div> : events.length===0 ? <div className="py-8 text-center text-sm text-[#6B7594]">No events yet — create a project or episode to generate the first audit entries.</div> : (
            <div className="space-y-2">
              {events.map(e=> (
                <div key={e.id} className="flex gap-3 rounded-xl border border-white/[0.06] bg-[#0F1425] px-3 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge>{e.type}</Badge>
                      {e.actor && <span className="font-mono text-[11px] text-[#6B7594]">{e.actor}</span>}
                      <span className="font-mono text-[11px] text-zinc-500">{new Date(e.created_at).toLocaleString()}</span>
                    </div>
                    {e.payload && <pre className="mt-2 overflow-auto rounded-lg bg-[#070A14] p-2 font-mono text-[11px] leading-5 text-zinc-300">{JSON.stringify(e.payload, null, 2)}</pre>}
                    {(e.task_id || e.episode_id) && <div className="mt-1 font-mono text-[11px] text-zinc-500">{e.task_id ? `task ${e.task_id.slice(0,8)}` : ""} {e.episode_id ? `ep ${e.episode_id.slice(0,8)}` : ""}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card>
          <div className="text-[13px] font-semibold text-white">Event types</div>
          <div className="mt-2 flex flex-wrap gap-1.5 font-mono text-[11px] text-[#6B7594]">
            {["worker.connected","worker.disconnected","task.created","task.started","task.waiting","task.completed","task.failed","artifact.created","artifact.versioned","agent.message","approval.requested","approval.granted","approval.rejected","youtube.upload.started","youtube.upload.completed"].map(t=>(
              <span key={t} className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-1">{t}</span>
            ))}
          </div>
        </Card>
      </main>
    </div>
  );
}
