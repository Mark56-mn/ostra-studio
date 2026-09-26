"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { TopNav } from "@/components/TopNav";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Pipeline } from "@/components/Pipeline";
import { apiUrl } from "@/lib/api";
import type { PipelineStep } from "@ostra/shared";

type Episode = { id:string; project_id:string; number:number; title:string; status:string; concept?:string|null; script?:string|null; narration?:string|null; youtube_video_id?:string|null; youtube_url?:string|null };
type Task = { id:string; type:string; worker_type:string; status:string; attempts:number; error?:string|null; created_at:string };
type Approval = { id:string; decision:string; note?:string|null; created_at:string };
type Scene = { id:string; index:number; title?:string|null; script_excerpt?:string|null; image_spec?:string|null; narration_segment?:string|null };
type Artifact = { id:string; kind:string; version:number; storage_path?:string|null; inline_text?:string|null; created_at:string };

const STEP: Record<string, PipelineStep> = {
  idea:"IDEA", writing:"SCRIPT", scenes:"SCENES", imaging:"IMAGES", voicing:"VOICE",
  rendering:"VIDEO", qc:"QC", ready_for_review:"REVIEW", approved:"REVIEW", uploading:"YOUTUBE", published:"YOUTUBE", archived:"YOUTUBE",
};

export default function EpisodePage() {
  const { id } = useParams<{id:string}>();
  const [ep, setEp] = useState<Episode|null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [err, setErr] = useState<string|null>(null);
  const [statusDraft, setStatusDraft] = useState<string>("");

  const [taskType, setTaskType] = useState("script.write");
  const [workerType, setWorkerType] = useState("script");
  const [sceneTitle, setSceneTitle] = useState("");

  async function load() {
    const r = await fetch(apiUrl(`/api/episodes/${id}`));
    const j = await r.json();
    if (r.ok) { setEp(j.episode as Episode); setStatusDraft((j.episode as Episode).status); }
    const [t,a,s,art] = await Promise.all([
      fetch(apiUrl(`/api/tasks?episodeId=${id}`)).then(x=>x.json()).catch(()=>({tasks:[]})),
      fetch(apiUrl(`/api/approvals?episodeId=${id}`)).then(x=>x.json()).catch(()=>({approvals:[]})),
      fetch(apiUrl(`/api/scenes?episodeId=${id}`)).then(x=>x.json()).catch(()=>({scenes:[]})),
      fetch(apiUrl(`/api/artifacts?episodeId=${id}`)).then(x=>x.json()).catch(()=>({artifacts:[]})),
    ]);
    setTasks(t.tasks ?? []); setApprovals(a.approvals ?? []); setScenes(s.scenes ?? []); setArtifacts(art.artifacts ?? []);
  }
  useEffect(()=>{ load(); }, [id]);

  async function createTask(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch(apiUrl("/api/tasks"), { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({
      project_id: ep?.project_id, episode_id: id, type: taskType, worker_type: workerType, input: { episodeId: id },
    }) });
    const j = await r.json(); if(!r.ok) setErr(j.error); else { setErr(null); load(); }
  }
  async function act(decision: "approved"|"rejected"|"changes_requested") {
    const r = await fetch(apiUrl("/api/approvals"), { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ episode_id: id, decision, decided_by: "human" }) });
    const j=await r.json(); if(!r.ok) setErr(j.error); else load();
  }
  async function updateStatus(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch(apiUrl(`/api/episodes/${id}`), { method:"PATCH", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ status: statusDraft }) });
    const j = await r.json(); if(!r.ok) setErr(j.error); else load();
  }
  async function addScene(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch(apiUrl("/api/scenes"), { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ episode_id: id, title: sceneTitle || null }) });
    const j = await r.json(); if(!r.ok) setErr(j.error); else { setSceneTitle(""); load(); }
  }

  if (!ep) return <div className="min-h-screen bg-[#070A14]"><TopNav /><div className="mx-auto max-w-[1100px] px-4 py-10 text-sm text-[#6B7594]">{err ?? "Loading episode…"}</div></div>;

  return (
    <div className="min-h-screen bg-[#070A14]">
      <TopNav />
      <main className="mx-auto max-w-[1100px] space-y-4 px-4 py-6 sm:px-6">
        {err && <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-200">{err}</div>}
        <Link href="/projects" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[#9AA3C0] hover:text-white">← Projects</Link>

        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-bold text-[#070A14]">EP {String(ep.number).padStart(2,"0")}</span>
                <Badge>{ep.status}</Badge>
              </div>
              <h1 className="mt-2 text-[20px] font-bold leading-tight text-white">{ep.title}</h1>
              {ep.concept && <p className="mt-1 max-w-[65ch] text-[13px] leading-6 text-[#9AA3C0]">{ep.concept}</p>}
            </div>
            <div className="flex gap-2">
              <button onClick={()=>act("approved")} className="rounded-full bg-emerald-500 px-4 py-2 text-[13px] font-semibold text-white hover:bg-emerald-600">Approve</button>
              <button onClick={()=>act("changes_requested")} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-[13px] font-semibold text-white hover:bg-white/10">Request changes</button>
              <button onClick={()=>act("rejected")} className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-[13px] font-semibold text-amber-200 hover:bg-white/10">Reject</button>
            </div>
          </div>
          <div className="mt-4"><Pipeline active={STEP[ep.status] ?? "IDEA"} /></div>
          <form onSubmit={updateStatus} className="mt-3 flex flex-wrap items-center gap-2 text-[12px]">
            <span className="label-mono text-[#6B7594]">Status</span>
            <select value={statusDraft} onChange={e=>setStatusDraft(e.target.value)} className="rounded-full border border-white/10 bg-[#0F1425] px-3 py-1.5 text-white">
              {["idea","writing","scenes","imaging","voicing","rendering","qc","ready_for_review","approved","uploading","published","archived"].map(s=> <option key={s} value={s}>{s}</option>)}
            </select>
            <button type="submit" className="rounded-full bg-white px-3 py-1.5 text-[12px] font-semibold text-[#070A14]">Update</button>
            <span className="text-[#6B7594]">Orchestrator advances this on task/approval events in Phase 2; manual override is audited.</span>
            {ep.youtube_url && <a href={ep.youtube_url} target="_blank" rel="noreferrer" className="rounded-full bg-red-500 px-2.5 py-1 font-semibold text-white">YouTube ↗</a>}
          </form>
        </Card>

        <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-4">
            <Card>
              <CardHeader kicker="ORCHESTRATOR" title={`Tasks — ${tasks.length}`} action={<button onClick={load} className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[12px] text-white">Refresh</button>} />
              {tasks.length===0 ? (
                <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-8 text-center text-sm text-[#6B7594]">No tasks yet. Create the first production task below — Render queues it even while workers are OFFLINE (no fake COMPLETED).</div>
              ) : (
                <div className="space-y-2">
                  {tasks.map(t=>(
                    <div key={t.id} className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-[#0F1425] px-3 py-2.5">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2"><span className="font-mono text-[12px] font-semibold text-white">{t.type}</span><Badge>{t.status}</Badge><span className="font-mono text-[11px] text-[#6B7594]">{t.worker_type}</span></div>
                        <div className="font-mono text-[11px] text-zinc-500">{t.id.slice(0,8)} · attempts {t.attempts} · {new Date(t.created_at).toLocaleString()}</div>
                        {t.error && <div className="mt-1 text-[11px] text-red-300">{t.error}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <form onSubmit={createTask} className="mt-4 grid gap-2 rounded-xl border border-white/[0.06] bg-[#0F1425] p-3 sm:grid-cols-[1fr_1fr_auto]">
                <select value={taskType} onChange={e=>setTaskType(e.target.value)} className="rounded-xl border border-white/10 bg-[#070A14] px-3 py-2.5 text-[13px] text-white">
                  <option value="script.develop">script.develop</option>
                  <option value="script.write">script.write</option>
                  <option value="script.scene_breakdown">script.scene_breakdown</option>
                  <option value="image.generate">image.generate</option>
                  <option value="voice.narration">voice.narration</option>
                  <option value="video.render">video.render</option>
                  <option value="qc.check">qc.check</option>
                </select>
                <select value={workerType} onChange={e=>setWorkerType(e.target.value)} className="rounded-xl border border-white/10 bg-[#070A14] px-3 py-2.5 text-[13px] text-white">
                  <option value="script">script</option>
                  <option value="image">image</option>
                  <option value="voice">voice</option>
                  <option value="video">video</option>
                </select>
                <button type="submit" className="rounded-full bg-[#FF4D5A] px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-[#ff5e6a]">Queue task</button>
              </form>
              <div className="mt-2 text-[11px] leading-4 text-[#6B7594]">Tasks respect <span className="font-mono text-white">depends_on</span>. Render holds the queue; Vercel never writes tasks directly to Supabase.</div>
            </Card>

            <Card>
              <CardHeader kicker="SCENES" title={`${scenes.length} scenes`} />
              {scenes.length===0 ? <div className="text-sm text-[#6B7594]">No scenes yet. They are created from script breakdowns — or manually below for testing.</div> : (
                <div className="space-y-2">{scenes.map(s=>(
                  <div key={s.id} className="rounded-xl border border-white/[0.06] bg-[#0F1425] px-3 py-2.5">
                    <div className="flex items-center gap-2"><Badge>#{s.index}</Badge><span className="text-[13px] font-semibold text-white">{s.title ?? `Scene ${s.index}`}</span></div>
                    {s.image_spec && <div className="mt-1 line-clamp-2 text-[12px] text-[#9AA3C0]">{s.image_spec}</div>}
                    <div className="mt-2 flex gap-2"><button onClick={async()=>{ await fetch(apiUrl(`/api/scenes/${s.id}`), { method:"DELETE"}); load(); }} className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-zinc-400 hover:bg-white/10">Delete</button></div>
                  </div>
                ))}</div>
              )}
              <form onSubmit={addScene} className="mt-3 flex gap-2">
                <input value={sceneTitle} onChange={e=>setSceneTitle(e.target.value)} placeholder="Scene title (optional)" className="min-w-0 flex-1 rounded-full border border-white/10 bg-[#070A14] px-4 py-2 text-[13px] text-white placeholder:text-zinc-500"/>
                <button type="submit" className="rounded-full bg-white px-4 py-2 text-[13px] font-semibold text-[#070A14]">Add scene</button>
              </form>
            </Card>
          </div>

          <div className="space-y-4">
            <Card>
              <CardHeader kicker="HUMAN REVIEW" title="Approvals" />
              {approvals.length===0 ? <div className="text-sm text-[#6B7594]">No decisions yet. Approve/reject from the buttons above — the episode status advances only on approval (when in <span className="font-mono">ready_for_review</span>).</div> : (
                <div className="space-y-2">
                  {approvals.map(a=>(
                    <div key={a.id} className="rounded-xl border border-white/[0.06] bg-[#0F1425] px-3 py-2.5">
                      <div className="flex items-center gap-2"><Badge>{a.decision}</Badge><span className="font-mono text-[11px] text-zinc-500">{new Date(a.created_at).toLocaleString()}</span></div>
                      {a.note && <div className="mt-1 text-[13px] text-zinc-300">{a.note}</div>}
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-3 rounded-xl bg-amber-500/10 px-3 py-2.5 text-[12px] leading-5 text-amber-200">YouTube upload is blocked until approval is <span className="font-semibold">approved</span>. Flip <span className="font-mono text-[11px]">AUTO_PUBLISH=true</span> on Render only if you mean it.</div>
            </Card>

            <Card>
              <CardHeader kicker="PRODUCTION ASSETS" title={`Artifacts — ${artifacts.length}`} />
              {artifacts.length===0 ? (
                <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-8 text-center text-sm leading-6 text-[#6B7594]">
                  No artifacts yet. Large binaries go to Supabase Storage (bucket <span className="font-mono text-white">ostra-assets</span>), metadata + version here. Versions are never destroyed.
                  <div className="mt-3 text-[11px]">Create via <span className="font-mono">POST /api/artifacts</span> on Render (or from worker adapters in Phases 4–7).</div>
                </div>
              ) : (
                <div className="space-y-2">{artifacts.map(a=>(
                  <div key={a.id} className="rounded-xl border border-white/[0.06] bg-[#0F1425] px-3 py-2.5">
                    <div className="flex items-center gap-2"><Badge>{a.kind}</Badge><span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-mono text-white">v{a.version}</span><span className="font-mono text-[11px] text-zinc-500">{new Date(a.created_at).toLocaleString()}</span></div>
                    {a.storage_path && <div className="mt-1 break-all font-mono text-[11px] text-sky-300">{a.storage_path}</div>}
                    {a.inline_text && <div className="mt-1 line-clamp-3 text-[12px] text-zinc-300">{a.inline_text}</div>}
                  </div>
                ))}</div>
              )}
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
