"use client";
import { useEffect, useMemo, useState } from "react";
import { TopNav } from "@/components/TopNav";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { AgentRoom, OFFLINE_AGENTS, type AgentRow } from "@/components/AgentRoom";
import { apiUrl } from "@/lib/api";

// ── Types ────────────────────────────────────────────────────────────────────
type Schedule = {
  id:string; worker_type:string; runtime:string; provider:string; enabled:boolean;
  local_time:string; timezone:string; days_of_week:number[]; label?:string|null;
  startup_mode:string; max_start_attempts:number; cooldown_minutes:number;
  created_at:string; updated_at:string;
};
type HistoryRow = {
  id:string; schedule_id?:string|null; worker_type:string; runtime:string; provider:string;
  trigger_source:string; result:string; status?:string|null; error?:string|null; error_code?:string|null;
  provider_run_id?:string|null; startup_request_id?:string|null;
  requested_at:string; started_at?:string|null; registered_at?:string|null; completed_at?:string|null;
  worker_id?:string|null;
};
type HealthResp = Record<string, { provider?: string; health?: { ok:boolean; status:string; reason?:string; latencyMs?:number; checkedAt?:string } }>;

const DAYS: Record<number,string> = {0:"Sun",1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri",6:"Sat"};
const DAYS_FULL = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

function nextRunLabel(s: Schedule): string {
  const days = (s.days_of_week && s.days_of_week.length) ? s.days_of_week.map(d=>DAYS[d]).join(",") : "Every day";
  return `${s.local_time} ${s.timezone} (${days})`;
}

function nextRunUtcHint(s: Schedule): string {
  try {
    const { h, m } = (()=>{ const [a,b]=s.local_time.split(":"); return { h: parseInt(a!,10), m: parseInt(b!,10)}; })();
    // Compute next run in local time via Intl — client-side hint only, server is authoritative
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: s.timezone, year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hour12:false });
    // Approximate: show that server tick converts timezone -> UTC on every tick
    void fmt; void h; void m; void now;
    return `Next run computed on Render each minute from ${s.local_time} ${s.timezone}`;
  } catch { return `${s.local_time} ${s.timezone}`; }
}

export default function RuntimesPage() {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>(OFFLINE_AGENTS);
  const [health, setHealth] = useState<HealthResp | null>(null);
  const [err, setErr] = useState<string|null>(null);
  const [notice, setNotice] = useState<string|null>(null);
  const [busy, setBusy] = useState<string|null>(null);

  // New schedule form
  const [form, setForm] = useState({ worker_type:"script", runtime:"kaggle", provider:"kaggle", local_time:"09:00", timezone:"Africa/Lagos", label:"Morning", startup_mode:"kaggle_kernel", days_of_week: [0,1,2,3,4,5,6] as number[] });
  // Edit inline — include days_of_week + max attempts
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [editDays, setEditDays] = useState<number[]>([]);

  async function loadSchedules() {
    const r = await fetch(apiUrl("/api/runtime/schedules")); const j = await r.json();
    if (!r.ok) setErr(j.error ?? "Failed to load schedules"); else { setErr(null); setSchedules(j.schedules ?? []); }
  }
  async function loadHistory() {
    const r = await fetch(apiUrl("/api/runtime/history?limit=40")); const j = await r.json();
    if (r.ok) setHistory(j.history ?? []);
  }
  async function loadAgents() {
    const [w,h] = await Promise.all([fetch(apiUrl("/api/workers")).then(r=>r.json()).catch(()=>({workers:OFFLINE_AGENTS})), fetch(apiUrl("/api/providers")).then(r=>r.json()).catch(()=>null)]);
    if (w.workers) setAgents(w.workers.map((x: Record<string,unknown>)=>({
      id: String(x["id"]), type: String(x["type"]) as AgentRow["type"],
      provider: String(x["provider"]), model: (x["model"] as string) ?? null,
      runtime: (x["runtime"] as string) ?? null, status: String(x["status"]),
      lastHeartbeatAt: (x["last_heartbeat_at"] as string) ?? (x["last_seen_at"] as string) ?? null,
      error: (x["error_message"] as string) ?? (x["error"] as string) ?? null,
      currentTaskId: (x["current_task"] as string) ?? (x["current_task_id"] as string) ?? null,
      endpoint: (x["endpoint"] as string) ?? null,
      heartbeatTimeoutSec: (x["heartbeat_timeout_sec"] as number) ?? null,
      registeredAt: (x["registered_at"] as string) ?? null,
    } as unknown as AgentRow)));
    if (h) setHealth(h);
  }

  useEffect(()=>{ loadSchedules(); loadHistory(); loadAgents(); const iv=setInterval(()=>{ loadHistory(); loadAgents(); }, 12_000); return ()=>clearInterval(iv); }, []);

  async function createSchedule(e: React.FormEvent) {
    e.preventDefault();
    setBusy("create"); setErr(null); setNotice(null);
    const payload = { ...form };
    const r = await fetch(apiUrl("/api/runtime/schedules"), { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload) });
    const j = await r.json();
    if (!r.ok) setErr(j.error ?? "Create failed"); else { setNotice(`Schedule ${j.schedule.local_time} ${j.schedule.timezone} created`); loadSchedules(); }
    setBusy(null);
  }
  async function toggleSchedule(s: Schedule) {
    setBusy(s.id);
    const r = await fetch(apiUrl(`/api/runtime/schedules/${s.id}`), { method:"PATCH", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ enabled: !s.enabled }) });
    const j = await r.json().catch(()=>null);
    if (!r.ok) setErr(j?.error ?? "Toggle failed"); else loadSchedules();
    setBusy(null);
  }
  async function saveEdit(e: React.FormEvent) {
    e.preventDefault(); if (!editing) return;
    setBusy(editing.id);
    const body = { ...editing, days_of_week: editDays };
    const r = await fetch(apiUrl(`/api/runtime/schedules/${editing.id}`), { method:"PATCH", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(()=>null);
    if (!r.ok) setErr(j?.error ?? "Save failed"); else { setEditing(null); loadSchedules(); }
    setBusy(null);
  }
  function openEdit(s: Schedule) {
    setEditing(s);
    setEditDays(s.days_of_week ?? [0,1,2,3,4,5,6]);
  }
  function toggleEditDay(d: number) {
    setEditDays(prev => prev.includes(d) ? prev.filter(x=>x!==d) : [...prev, d].sort((a,b)=>a-b));
  }
  function toggleFormDay(d: number) {
    setForm(prev => {
      const next = prev.days_of_week.includes(d) ? prev.days_of_week.filter(x=>x!==d) : [...prev.days_of_week, d].sort((a,b)=>a-b);
      if (next.length === 0) return prev; // don't allow empty
      return { ...prev, days_of_week: next };
    });
  }
  async function deleteSchedule(id: string) {
    if (!confirm("Delete this schedule?")) return;
    setBusy(id);
    const r = await fetch(apiUrl(`/api/runtime/schedules/${id}`), { method:"DELETE" });
    const j = await r.json().catch(()=>null);
    if (!r.ok) setErr(j?.error ?? "Delete failed"); else loadSchedules();
    setBusy(null);
  }
  async function seedDefaults() {
    setBusy("seed");
    const r = await fetch(apiUrl("/api/runtime/schedules/seed"), { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ timezone:"Africa/Lagos" }) });
    const j = await r.json().catch(()=>null);
    if (!r.ok) setErr(j?.error ?? "Seed failed"); else { setNotice(`Seeded ${j.created?.length ?? 0} defaults (Africa/Lagos)`); loadSchedules(); }
    setBusy(null);
  }
  async function runNowSchedule(id: string) {
    setBusy(`run:${id}`);
    const r = await fetch(apiUrl("/api/runtime/run-now"), { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ schedule_id:id }) });
    const j = await r.json().catch(()=>null);
    if (!r.ok && !j?.action) setErr(j?.error ?? "Run Now failed");
    else { setNotice(`Run Now: ${j.action ?? "unknown"} ${j.error ? `— ${j.error}` : ""}`); loadHistory(); loadAgents(); }
    setBusy(null);
  }
  async function runNowWorker(worker_type:string, runtime:string, provider:string) {
    setBusy(`runw:${worker_type}:${runtime}`);
    const r = await fetch(apiUrl("/api/runtime/run-now"), { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ worker_type, runtime, provider }) });
    const j = await r.json().catch(()=>null);
    if (!r.ok && !j?.action) setErr(j?.error ?? "Run Now failed");
    else { setNotice(`Run Now ${worker_type}/${runtime}: ${j.action ?? "unknown"} ${j.error ? `— ${j.error}` : ""}`); loadHistory(); loadAgents(); }
    setBusy(null);
  }

  const grouped = useMemo(()=>{
    const m = new Map<string, Schedule[]>();
    for (const s of schedules ?? []) { const k = `${s.worker_type}/${s.runtime} (${s.provider})`; if (!m.has(k)) m.set(k, []); m.get(k)!.push(s); }
    return Array.from(m.entries()).sort((a,b)=>a[0].localeCompare(b[0]));
  }, [schedules]);

  return (
    <div className="min-h-screen bg-[#070A14]">
      <TopNav/>
      <main className="mx-auto max-w-[1100px] space-y-4 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="label-mono text-[#6B7594]">ORCHESTRATOR — RENDER</div>
            <h1 className="text-[22px] font-bold tracking-tight text-white">Runtimes</h1>
            <p className="max-w-[64ch] text-[13px] leading-6 text-[#9AA3C0]">When a schedule fires, Render checks the real worker health, acquires a persisted lease, and asks the <span className="text-white">RuntimeStarter</span> to start the external runtime. Only a verified heartbeat makes the worker <span className="text-white">ONLINE</span> — never a fake. Colab Image/Voice shows <span className="text-white">NOT_AUTOSTARTABLE</span> until a real trigger is proven.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={seedDefaults} disabled={!!busy} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-[13px] font-semibold text-white hover:bg-white/10 disabled:opacity-60">Seed 09/14/20</button>
            <button onClick={()=>{ loadSchedules(); loadHistory(); loadAgents(); }} disabled={!!busy} className="rounded-full bg-white px-4 py-2 text-[13px] font-semibold text-[#070A14] disabled:opacity-60">Refresh</button>
          </div>
        </div>

        {err && <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-200">{err} — check Render env: <span className="font-mono">SUPABASE_URL</span>, <span className="font-mono">SUPABASE_SERVICE_ROLE_KEY</span>, <span className="font-mono">KAGGLE_*</span>. Frontend never holds secrets.</div>}
        {notice && <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-[13px] text-emerald-200">{notice}</div>}

        <AgentRoom agents={agents} />

        {/* Health strip */}
        <Card>
          <CardHeader kicker="PROVIDER HEALTH" title="Live probe — Render owns the call" />
          {!health ? <div className="text-sm text-[#6B7594]">Loading…</div> : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {Object.entries(health).map(([k,v])=> {
                const ok = v.health?.ok;
                return (
                  <div key={k} className={`rounded-xl border px-3 py-3 ${ok ? "border-emerald-500/20 bg-emerald-500/10" : "border-white/[0.06] bg-white/[0.03]"}`}>
                    <div className="flex items-center justify-between"><span className="text-[12px] font-bold text-white">{k.toUpperCase()} · {v.provider ?? "—"}</span><span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${ok ? "bg-emerald-500 text-white" : "bg-white/10 text-zinc-300"}`}>{v.health?.status ?? "UNKNOWN"}</span></div>
                    {v.health?.reason && <div className="mt-1 text-[12px] text-[#9AA3C0]">{v.health.reason}</div>}
                    <div className="mt-1 flex gap-3 font-mono text-[11px] text-[#6B7594]">{typeof v.health?.latencyMs==="number" && <span>{v.health.latencyMs}ms</span>}{v.health?.checkedAt && <span>{new Date(v.health.checkedAt).toLocaleTimeString()}</span>}</div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="mt-3 hidden gap-2 sm:flex">
            <button onClick={()=>runNowWorker("script","kaggle","kaggle")} disabled={!!busy} className="rounded-full bg-[#FF4D5A] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#ff5e6a] disabled:opacity-60">Run Now Script/Kaggle</button>
            <button onClick={()=>runNowWorker("image","colab","colab-image")} disabled={!!busy} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-[13px] font-semibold text-white hover:bg-white/10 disabled:opacity-60">Run Now Image/Colab</button>
            <button onClick={()=>runNowWorker("voice","colab","kokoro-82m")} disabled={!!busy} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-[13px] font-semibold text-white hover:bg-white/10 disabled:opacity-60">Run Now Voice/Colab</button>
          </div>
          <div className="mt-2 text-[11px] text-[#6B7594]">Run Now uses the same lease/duplicate protection as the scheduler. If the worker is already healthy it returns <span className="font-mono text-white">skipped_already_online</span> — never a duplicate start.</div>
        </Card>

        {/* Schedules */}
        <Card>
          <CardHeader kicker="SCHEDULES — PERSISTED IN SUPABASE" title={`${schedules?.length ?? 0} schedules`} action={<span className="label-mono hidden text-[#6B7594] sm:inline">editable · timezone-aware · one lease per worker/runtime</span>} />
          {schedules===null ? <div className="py-8 text-center text-sm text-[#6B7594]">Loading…</div> : schedules.length===0 ? (
            <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-8 text-center text-sm text-[#6B7594]">No schedules yet. Add one below or seed the defaults (09:00 / 14:00 / 20:00 Africa/Lagos) — you can change 09:00→05:00 later without touching code.</div>
          ) : (
            <div className="space-y-4">
              {grouped.map(([key, items])=> (
                <div key={key} className="space-y-2">
                  <div className="label-mono text-[#6B7594]">{key}</div>
                  <div className="grid gap-2">
                    {items.map(s=> (
                      <div key={s.id} className={`rounded-xl border px-3 py-3 ${s.enabled ? "border-white/[0.08] bg-[#0F1425]" : "border-white/[0.03] bg-white/[0.02] opacity-80"}`}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              {s.label && <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-bold text-[#070A14]">{s.label}</span>}
                              <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${s.enabled ? "bg-emerald-500 text-white" : "bg-white/10 text-zinc-400"}`}>{s.enabled ? "ON" : "OFF"}</span>
                              <span className="font-mono text-[13px] font-semibold text-white">{s.local_time}</span>
                              <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] text-zinc-300">{s.timezone}</span>
                              <Badge>{s.startup_mode}</Badge>
                            </div>
                            <div className="mt-1 font-mono text-[11px] text-[#6B7594]">{nextRunLabel(s)} · cd {s.cooldown_minutes}m · retries≤{s.max_start_attempts} · {s.id.slice(0,8)}</div>
                            <div className="mt-1 text-[11px] text-[#6B7594]">{nextRunUtcHint(s)}</div>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            <button onClick={()=>runNowSchedule(s.id)} disabled={!!busy} className="rounded-full bg-white px-3 py-1.5 text-[11px] font-semibold text-[#070A14] disabled:opacity-60">Run Now</button>
                            <button onClick={()=>toggleSchedule(s)} disabled={!!busy} className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-60">{s.enabled ? "Pause" : "Resume"}</button>
                            <button onClick={()=>openEdit(s)} className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] font-semibold text-white">Edit</button>
                            <button onClick={()=>deleteSchedule(s.id)} disabled={!!busy} className="rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] font-semibold text-red-300 disabled:opacity-60">Delete</button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* New schedule form */}
          <div className="mt-4 rounded-xl border border-white/[0.06] bg-[#0F1425] p-3">
            <form onSubmit={createSchedule} className="grid gap-2 sm:grid-cols-[auto_auto_1fr_auto_auto_auto]">
              <select value={form.worker_type} onChange={e=>setForm({...form, worker_type:e.target.value})} className="rounded-full border border-white/10 bg-[#070A14] px-3 py-2 text-[13px] text-white">
                <option value="script">script</option><option value="image">image</option><option value="voice">voice</option>
              </select>
              <select value={form.runtime} onChange={e=>setForm({...form, runtime:e.target.value})} className="rounded-full border border-white/10 bg-[#070A14] px-3 py-2 text-[13px] text-white">
                <option value="kaggle">kaggle</option><option value="colab">colab</option>
              </select>
              <input value={form.provider} onChange={e=>setForm({...form, provider:e.target.value})} placeholder="provider — e.g. kaggle" className="rounded-full border border-white/10 bg-[#070A14] px-3 py-2 text-[13px] text-white placeholder:text-zinc-500"/>
              <input value={form.local_time} onChange={e=>setForm({...form, local_time:e.target.value})} placeholder="HH:MM" className="w-28 rounded-full border border-white/10 bg-[#070A14] px-3 py-2 font-mono text-[13px] text-white placeholder:text-zinc-500"/>
              <input value={form.timezone} onChange={e=>setForm({...form, timezone:e.target.value})} placeholder="timezone" className="w-36 rounded-full border border-white/10 bg-[#070A14] px-3 py-2 text-[13px] text-white placeholder:text-zinc-500"/>
              <input value={form.label} onChange={e=>setForm({...form, label:e.target.value})} placeholder="label" className="w-28 rounded-full border border-white/10 bg-[#070A14] px-3 py-2 text-[13px] text-white placeholder:text-zinc-500"/>
              <select value={form.startup_mode} onChange={e=>setForm({...form, startup_mode:e.target.value})} className="rounded-full border border-white/10 bg-[#070A14] px-3 py-2 text-[13px] text-white">
                <option value="kaggle_kernel">kaggle_kernel</option><option value="colab_notebook">colab_notebook</option><option value="not_autostartable">not_autostartable</option>
              </select>
              <button type="submit" disabled={!!busy} className="rounded-full bg-[#FF4D5A] px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-60">Add schedule</button>
            </form>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-[#6B7594]">Days:</span>
              {[0,1,2,3,4,5,6].map(d=> (
                <button key={d} type="button" onClick={()=>toggleFormDay(d)} className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${form.days_of_week.includes(d) ? "bg-white text-[#070A14]" : "border border-white/10 bg-white/[0.04] text-zinc-400"}`}>{DAYS[d]}</button>
              ))}
            </div>
          </div>
          <div className="mt-2 text-[11px] text-[#6B7594]">Stored as <span className="font-mono text-white">runtime_schedules.local_time</span> + <span className="font-mono text-white">timezone</span> + <span className="font-mono text-white">days_of_week</span>. Render converts to UTC on every tick — change 09:00→05:00 and the next run moves, no code deploy needed.</div>
        </Card>

        {editing && (
          <Card>
            <CardHeader kicker="EDIT SCHEDULE" title={editing.label ?? editing.local_time} action={<button onClick={()=>setEditing(null)} className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] text-white">Close</button>} />
            <form onSubmit={saveEdit} className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1"><span className="label-mono text-[#6B7594]">local_time HH:MM</span><input value={editing.local_time} onChange={e=>setEditing({...editing, local_time:e.target.value})} className="w-full rounded-xl border border-white/10 bg-[#070A14] px-3 py-2 font-mono text-[13px] text-white"/></label>
              <label className="space-y-1"><span className="label-mono text-[#6B7594]">timezone IANA</span><input value={editing.timezone} onChange={e=>setEditing({...editing, timezone:e.target.value})} className="w-full rounded-xl border border-white/10 bg-[#070A14] px-3 py-2 text-[13px] text-white"/></label>
              <label className="space-y-1"><span className="label-mono text-[#6B7594]">label</span><input value={editing.label ?? ""} onChange={e=>setEditing({...editing, label:e.target.value})} className="w-full rounded-xl border border-white/10 bg-[#070A14] px-3 py-2 text-[13px] text-white"/></label>
              <label className="space-y-1"><span className="label-mono text-[#6B7594]">startup_mode</span><select value={editing.startup_mode} onChange={e=>setEditing({...editing, startup_mode:e.target.value})} className="w-full rounded-xl border border-white/10 bg-[#070A14] px-3 py-2 text-[13px] text-white"><option value="kaggle_kernel">kaggle_kernel</option><option value="colab_notebook">colab_notebook</option><option value="not_autostartable">not_autostartable</option></select></label>
              <label className="space-y-1"><span className="label-mono text-[#6B7594]">cooldown_minutes</span><input type="number" value={editing.cooldown_minutes} onChange={e=>setEditing({...editing, cooldown_minutes: parseInt(e.target.value,10)||0})} className="w-full rounded-xl border border-white/10 bg-[#070A14] px-3 py-2 text-[13px] text-white"/></label>
              <label className="space-y-1"><span className="label-mono text-[#6B7594]">max_start_attempts</span><input type="number" min={1} max={10} value={editing.max_start_attempts} onChange={e=>setEditing({...editing, max_start_attempts: parseInt(e.target.value,10)||1})} className="w-full rounded-xl border border-white/10 bg-[#070A14] px-3 py-2 text-[13px] text-white"/></label>
              <label className="space-y-1"><span className="label-mono text-[#6B7594]">enabled</span><select value={String(editing.enabled)} onChange={e=>setEditing({...editing, enabled: e.target.value==="true"})} className="w-full rounded-xl border border-white/10 bg-[#070A14] px-3 py-2 text-[13px] text-white"><option value="true">ON</option><option value="false">OFF</option></select></label>
              <div className="space-y-1 sm:col-span-2">
                <span className="label-mono text-[#6B7594]">days_of_week</span>
                <div className="flex flex-wrap gap-1.5">
                  {[0,1,2,3,4,5,6].map(d=> (
                    <button key={d} type="button" onClick={()=>toggleEditDay(d)} className={`rounded-full px-3 py-1.5 text-[12px] font-semibold ${editDays.includes(d) ? "bg-white text-[#070A14]" : "border border-white/10 bg-white/[0.04] text-zinc-400"}`}>{DAYS_FULL[d]}</button>
                  ))}
                </div>
                {editDays.length===0 && <div className="text-[11px] text-amber-300">Select at least one day</div>}
              </div>
              <button type="submit" disabled={!!busy || editDays.length===0} className="rounded-full bg-white px-5 py-2.5 text-[13px] font-semibold text-[#070A14] disabled:opacity-60 sm:col-span-2">Save</button>
            </form>
          </Card>
        )}

        {/* Startup history */}
        <Card>
          <CardHeader kicker="STARTUP HISTORY — ON RENDER" title={`${history.length} attempts`} action={<button onClick={loadHistory} className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] text-white">Refresh</button>} />
          {history.length===0 ? <div className="py-8 text-center text-sm text-[#6B7594]">No attempts yet — trigger a schedule or Run Now to generate the first entry. Each row is `runtime_startup_history` on Render (survives restart).</div> : (
            <div className="space-y-2">
              {history.map(h=> (
                <div key={h.id} className="rounded-xl border border-white/[0.06] bg-[#0F1425] px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>{h.worker_type}/{h.runtime}</Badge>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${h.result==="requested" || h.status==="REQUESTED" ? "bg-emerald-500 text-white" : h.result.startsWith("skipped") || h.status==="CANCELLED" ? "bg-amber-500/15 text-amber-300" : h.result==="not_autostartable" ? "bg-white/10 text-zinc-400" : h.result==="failed" || h.status==="FAILED" ? "bg-red-500/15 text-red-300" : h.result==="starting" || h.status==="STARTING" ? "bg-sky-500/15 text-sky-300" : h.status==="REGISTERING" ? "bg-violet-500/15 text-violet-300" : h.status==="ONLINE" ? "bg-emerald-500 text-white" : h.status==="TIMEOUT" ? "bg-red-500/15 text-red-300" : "bg-white/10 text-zinc-400"}`}>{h.status ?? h.result}</span>
                    <span className="font-mono text-[11px] text-zinc-500">{h.trigger_source}</span>
                    <span className="font-mono text-[11px] text-zinc-500">{new Date(h.requested_at).toLocaleString()}</span>
                  </div>
                  {(h.error || h.error_code) && <div className="mt-1 line-clamp-2 text-[12px] text-red-300">{h.error_code ? `[${h.error_code}] ` : ""}{h.error}</div>}
                  <div className="mt-1 font-mono text-[11px] text-[#6B7594]">{h.id.slice(0,8)} {h.schedule_id ? `sched ${h.schedule_id.slice(0,8)}` : "no sched"} {h.provider_run_id ? `run ${h.provider_run_id.slice(0,18)}` : ""} {h.startup_request_id ? `req ${h.startup_request_id.slice(0,12)}` : ""} {h.started_at ? `started ${new Date(h.started_at).toLocaleTimeString()}` : ""} {h.registered_at ? `registered ${new Date(h.registered_at).toLocaleTimeString()}` : ""}</div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-3 text-[11px] text-[#6B7594]">Cases covered per spec: <span className="text-white">A</span> already-online skip, <span className="text-white">B</span> Kaggle failure → OFFLINE + tasks QUEUED, <span className="text-white">C</span> no-registration timeout → <span className="font-mono text-white">TIMEOUT</span>, <span className="text-white">D</span> re-registration with new endpoint, <span className="text-white">E</span> lease survives Render restart, <span className="text-white">F</span> schedule edit moves next run. Lifecycle: <span className="font-mono text-white">REQUESTED→STARTING→REGISTERING→ONLINE / FAILED / TIMEOUT / CANCELLED</span>.</div>
        </Card>

        {/* Events */}
        <Card>
          <div className="label-mono mb-2 text-[#6B7594]">OPERATIONAL EVENTS — AUDIT</div>
          <div className="flex flex-wrap gap-1.5 font-mono text-[11px]">
            {["scheduler.triggered","scheduler.skipped_already_online","scheduler.skipped_in_progress","scheduler.skipped_cooldown","scheduler.skipped_not_autostartable","scheduler.start_requested","scheduler.start_failed","worker.registration_received","worker.health_check_passed","worker.heartbeat_received","worker.timeout","worker.offline"].map(t=> <span key={t} className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-1 text-[#6B7594]">{t}</span>)}
          </div>
          <div className="mt-2 text-[11px] text-[#6B7594]">Visible in <span className="text-white">/activity</span>. Never emits fake completion; never logs secrets.</div>
        </Card>
      </main>
    </div>
  );
}
