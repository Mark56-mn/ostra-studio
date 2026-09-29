"use client";
import { apiUrl } from "@/lib/api";
import { useEffect, useState } from "react";
import Link from "next/link";
import { TopNav } from "@/components/TopNav";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { AgentRoom, type AgentRow } from "@/components/AgentRoom";
import { Pipeline } from "@/components/Pipeline";
import { resolveProjectSlug, type PipelineStep } from "@ostra/shared";

type Project = { id:string; slug:string; title:string; logline?:string|null; created_at:string };
type Episode = { id:string; project_id:string; number:number; title:string; status:string; concept?:string|null; created_at:string };

const STATUS_STEP: Record<string, PipelineStep> = {
  idea:"IDEA", writing:"SCRIPT", scenes:"SCENES", imaging:"IMAGES", voicing:"VOICE",
  rendering:"VIDEO", qc:"QC", ready_for_review:"REVIEW", approved:"REVIEW", uploading:"YOUTUBE", published:"YOUTUBE", archived:"YOUTUBE",
};

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [slug, setSlug] = useState(""); const [title, setTitle] = useState(""); const [logline, setLogline] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [epTitle, setEpTitle] = useState(""); const [epConcept, setEpConcept] = useState("");

  async function loadProjects() {
    const r = await fetch(apiUrl("/api/projects"));
    const j = await r.json();
    if (!r.ok) { setErr(j.error ?? "Failed to load projects"); setProjects([]); return; }
    setErr(null); setProjects(j.projects);
    if (j.projects?.length && !selected) setSelected(j.projects[0].id);
  }
  async function loadEpisodes(pid: string) {
    const r = await fetch(apiUrl(`/api/episodes?projectId=${pid}`)); const j = await r.json();
    if (r.ok) setEpisodes(j.episodes);
  }
  async function loadWorkers() {
    const r = await fetch(apiUrl("/api/workers")); const j = await r.json().catch(() => null);
    // No synthetic fallback: workers are shown only when the backend actually returned them.
    if (Array.isArray(j?.workers)) setAgents(j.workers.map((w: Record<string,unknown>) => ({
      id: String(w["id"]), type: String(w["type"]) as AgentRow["type"],
      provider: String(w["provider"]), model: (w["model"] as string) ?? null,
      runtime: (w["runtime"] as string) ?? null, status: String(w["status"]),
      health: (w["health"] as AgentRow["health"]) ?? null,
      lastHeartbeatAt: (w["last_heartbeat_at"] as string) ?? null,
      error: (w["error_message"] as string) ?? (w["error"] as string) ?? null,
    })));
    else setAgents([]);
  }

  useEffect(()=>{ loadProjects(); loadWorkers(); }, []);
  useEffect(()=>{ if (selected) loadEpisodes(selected); }, [selected]);

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    // Send a normalized slug (or none — the API derives one from the title). Never an invalid value.
    const r = await fetch(apiUrl("/api/projects"), { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ slug: resolveProjectSlug(slug, title), title, logline }) });
    const j = await r.json();
    if (!r.ok) setErr(j.error); else { setSlug(""); setTitle(""); setLogline(""); setSlugTouched(false); setErr(null); loadProjects(); }
  }
  async function createEpisode(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    const r = await fetch(apiUrl("/api/episodes"), { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ project_id: selected, title: epTitle, concept: epConcept }) });
    const j = await r.json();
    if (!r.ok) setErr(j.error); else { setEpTitle(""); setEpConcept(""); loadEpisodes(selected); }
  }

  const selProject = projects?.find(p=>p.id===selected) ?? null;

  return (
    <div className="min-h-screen bg-[#070A14]">
      <TopNav />
      <main className="mx-auto max-w-[1100px] space-y-4 px-4 py-6 sm:px-6">
        {err && <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-200">{err}</div>}

        <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
          <div className="space-y-4">
            <Card>
              <CardHeader kicker="CONTROL PLANE" title="Projects" />
              {projects === null ? (
                <div className="py-6 text-center text-sm text-[#6B7594]">Loading…</div>
              ) : projects.length === 0 ? (
                <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-6 text-center text-sm leading-6 text-[#6B7594]">
                  No projects yet. Create the first one below. Your story bible lives per project so continuity persists across episodes.
                </div>
              ) : (
                <div className="space-y-2">
                  {projects.map(p=> (
                    <button key={p.id} onClick={()=>setSelected(p.id)}
                      className={`w-full rounded-xl border px-4 py-3 text-left transition ${selected===p.id ? "border-[#FF4D5A]/40 bg-[#FF4D5A]/10" : "border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.06]"}`}>
                      <div className="text-[13px] font-semibold text-white">{p.title}</div>
                      <div className="font-mono text-[11px] text-[#6B7594]">{p.slug}</div>
                      {p.logline && <div className="mt-1 line-clamp-2 text-[12px] leading-5 text-[#9AA3C0]">{p.logline}</div>}
                    </button>
                  ))}
                </div>
              )}

              <form onSubmit={createProject} className="mt-4 space-y-2 rounded-xl border border-white/[0.06] bg-[#0F1425] p-3">
                <div className="label-mono text-[#6B7594]">NEW PROJECT</div>
                <input value={title} onChange={e=>{ setTitle(e.target.value); if(!slugTouched) setSlug(resolveProjectSlug("", e.target.value)); }} placeholder="Title — e.g. Crimson Ink" className="w-full rounded-lg border border-white/10 bg-[#070A14] px-3 py-2 text-[13px] text-white placeholder:text-zinc-500" />
                <input value={slug} onChange={e=>{ setSlugTouched(true); setSlug(e.target.value); }} placeholder="slug (optional) — auto from title" className="w-full rounded-lg border border-white/10 bg-[#070A14] px-3 py-2 text-[13px] text-white placeholder:text-zinc-500" />
                <div className="text-[11px] leading-4 text-[#6B7594]">Slug is normalized to lowercase a-z, 0-9 and hyphens. Leave it blank and it follows the title.</div>
                <input value={logline} onChange={e=>setLogline(e.target.value)} placeholder="Logline (optional)" className="w-full rounded-lg border border-white/10 bg-[#070A14] px-3 py-2 text-[13px] text-white placeholder:text-zinc-500" />
                <button type="submit" className="w-full rounded-full bg-white px-4 py-2 text-[13px] font-semibold text-[#070A14] hover:bg-zinc-100">Create project</button>
                <div className="text-[11px] leading-4 text-[#6B7594]">Render API: <span className="font-mono">POST /api/projects</span> → Supabase. Vercel never holds secrets.</div>
              </form>
            </Card>

            <AgentRoom agents={agents} />
          </div>

          <div className="space-y-4">
            {!selProject ? (
              <Card><div className="py-10 text-center text-sm text-[#6B7594]">Select a project to manage its episodes.</div></Card>
            ) : (
              <>
                <Card>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="label-mono text-[#6B7594]">EPISODES — {selProject.slug}</div>
                      <div className="text-[16px] font-semibold text-white">{selProject.title}</div>
                    </div>
                    <Link href={`/projects/${selProject.id}`} className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-white/10">Open</Link>
                  </div>

                  {episodes.length === 0 ? (
                    <div className="mt-4 rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-8 text-center text-sm text-[#6B7594]">
                      No episodes yet — create EP 01 to start the pipeline.
                    </div>
                  ) : (
                    <div className="mt-3 space-y-3">
                      {episodes.map(ep=> {
                        const step = STATUS_STEP[ep.status] ?? "IDEA";
                        return (
                          <div key={ep.id} className="rounded-xl border border-white/[0.06] bg-[#0F1425] p-3 sm:p-4">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-bold text-[#070A14]">EP {String(ep.number).padStart(2,"0")}</span>
                                  <Badge>{ep.status}</Badge>
                                </div>
                                <div className="mt-1 text-[14px] font-semibold text-white">{ep.title}</div>
                                {ep.concept && <div className="mt-1 max-w-[60ch] text-[12px] leading-5 text-[#9AA3C0]">{ep.concept}</div>}
                              </div>
                              <Link href={`/episodes/${ep.id}`} className="rounded-full bg-white px-3 py-1.5 text-[12px] font-semibold text-[#070A14]">View</Link>
                            </div>
                            <div className="mt-3">
                              <Pipeline active={step} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <form onSubmit={createEpisode} className="mt-4 flex flex-col gap-2 sm:flex-row">
                    <input value={epTitle} onChange={e=>setEpTitle(e.target.value)} placeholder="New episode title — e.g. The night the ink bled" className="min-w-0 flex-1 rounded-full border border-white/10 bg-[#070A14] px-4 py-2.5 text-[13px] text-white placeholder:text-zinc-500" />
                    <button type="submit" className="shrink-0 rounded-full bg-[#FF4D5A] px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-[#ff5e6a]">Add episode</button>
                  </form>
                  <input value={epConcept} onChange={e=>setEpConcept(e.target.value)} placeholder="Concept (optional) — one sentence premise for this episode" className="mt-2 w-full rounded-xl border border-white/10 bg-[#070A14] px-4 py-2.5 text-[13px] text-white placeholder:text-zinc-500" />
                </Card>

                <Card>
                  <CardHeader kicker="ORCHESTRATOR" title="What happens next" />
                  <ul className="space-y-2 text-[13px] leading-6 text-[#9AA3C0]">
                    <li>• Create tasks (script → scenes → images → voice → video). Each task records <span className="text-white">depends_on</span> so the orchestrator won&apos;t start imaging before scenes exist.</li>
                    <li>• Workers heartbeat independently from tasks. <span className="font-mono text-[11px] text-white">OFFLINE</span> just queues work — no fake completion.</li>
                    <li>• Failed tasks keep successful artifacts. Retry without nuking good versions.</li>
                    <li>• When an episode hits <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[11px] text-white">ready_for_review</span>, the review gate holds until you approve.</li>
                  </ul>
                </Card>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
