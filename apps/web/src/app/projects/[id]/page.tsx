"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { TopNav } from "@/components/TopNav";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { apiUrl } from "@/lib/api";

type Project = { id:string; slug:string; title:string; logline?:string|null; story_bible?: Record<string,unknown>|null };
type Episode = { id:string; number:number; title:string; status:string; concept?:string|null };
type Character = { id:string; name:string; role?:string|null; description?:string|null; visual_ref?:string|null };
type Location = { id:string; name:string; description?:string|null; visual_ref?:string|null };

export default function ProjectDetail() {
  const { id } = useParams<{id:string}>();
  const [project, setProject] = useState<Project|null>(null);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [err, setErr] = useState<string|null>(null);

  // bible form
  const [premise, setPremise] = useState(""); const [worldRules, setWorldRules] = useState(""); const [visualStyle, setVisualStyle] = useState("");
  const [charName, setCharName] = useState(""); const [charRole, setCharRole] = useState("");
  const [locName, setLocName] = useState(""); const [locDesc, setLocDesc] = useState("");

  async function load() {
    const r = await fetch(apiUrl(`/api/projects/${id}`)); const j = await r.json();
    if (!r.ok) { setErr(j.error ?? "Failed to load project"); return; }
    const p = j.project as Project; setProject(p);
    setPremise((p.story_bible as Record<string,string> | null)?.premise ?? "");
    setWorldRules((p.story_bible as Record<string,string> | null)?.worldRules ?? "");
    setVisualStyle((p.story_bible as Record<string,string> | null)?.visualStyle ?? "");
    const [e,c,l] = await Promise.all([
      fetch(apiUrl(`/api/episodes?projectId=${id}`)).then(x=>x.json()).catch(()=>({episodes:[]})),
      fetch(apiUrl(`/api/characters?projectId=${id}`)).then(x=>x.json()).catch(()=>({characters:[]})),
      fetch(apiUrl(`/api/locations?projectId=${id}`)).then(x=>x.json()).catch(()=>({locations:[]})),
    ]);
    setEpisodes(e.episodes ?? []); setCharacters(c.characters ?? []); setLocations(l.locations ?? []);
  }
  useEffect(()=>{ load(); }, [id]);

  async function saveBible(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch(apiUrl(`/api/projects/${id}`), { method:"PATCH", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ story_bible: { premise, worldRules, visualStyle } }) });
    const j = await r.json(); if (!r.ok) setErr(j.error); else { setErr(null); load(); }
  }
  async function addCharacter(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch(apiUrl("/api/characters"), { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ project_id: id, name: charName, role: charRole }) });
    const j = await r.json(); if(!r.ok) setErr(j.error); else { setCharName(""); setCharRole(""); load(); }
  }
  async function addLocation(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch(apiUrl("/api/locations"), { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ project_id: id, name: locName, description: locDesc }) });
    const j = await r.json(); if(!r.ok) setErr(j.error); else { setLocName(""); setLocDesc(""); load(); }
  }

  if (!project) return <div className="min-h-screen bg-[#070A14]"><TopNav/><div className="mx-auto max-w-[1100px] px-4 py-10 text-sm text-[#6B7594]">{err ?? "Loading project…"}</div></div>;

  return (
    <div className="min-h-screen bg-[#070A14]">
      <TopNav/>
      <main className="mx-auto max-w-[1100px] space-y-4 px-4 py-6 sm:px-6">
        {err && <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-200">{err}</div>}
        <Link href="/projects" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[#9AA3C0] hover:text-white">← Projects</Link>
        <Card>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="label-mono text-[#6B7594]">PROJECT · {project.slug}</div>
              <h1 className="text-[22px] font-bold text-white">{project.title}</h1>
              {project.logline && <p className="mt-1 max-w-[60ch] text-[13px] leading-6 text-[#9AA3C0]">{project.logline}</p>}
            </div>
            <Badge>story bible</Badge>
          </div>
          <form onSubmit={saveBible} className="mt-4 grid gap-3">
            <label className="space-y-1"><span className="label-mono text-[#6B7594]">Premise</span><textarea value={premise} onChange={e=>setPremise(e.target.value)} placeholder="World premise — who, where, stakes" rows={3} className="w-full rounded-xl border border-white/10 bg-[#0F1425] px-3 py-2.5 text-[13px] text-white placeholder:text-zinc-500"/></label>
            <label className="space-y-1"><span className="label-mono text-[#6B7594]">World rules</span><textarea value={worldRules} onChange={e=>setWorldRules(e.target.value)} placeholder="Magic / tech / factions / limits" rows={3} className="w-full rounded-xl border border-white/10 bg-[#0F1425] px-3 py-2.5 text-[13px] text-white placeholder:text-zinc-500"/></label>
            <label className="space-y-1"><span className="label-mono text-[#6B7594]">Visual style</span><textarea value={visualStyle} onChange={e=>setVisualStyle(e.target.value)} placeholder="Art direction, palette, lighting, aspect ratio" rows={2} className="w-full rounded-xl border border-white/10 bg-[#0F1425] px-3 py-2.5 text-[13px] text-white placeholder:text-zinc-500"/></label>
            <button type="submit" className="w-fit rounded-full bg-white px-5 py-2.5 text-[13px] font-semibold text-[#070A14]">Save story bible</button>
            <div className="text-[11px] text-[#6B7594]">Persisted as <span className="font-mono text-white">projects.story_bible</span> (jsonb) — the shared context Script/Image/Voice will read from. Render owns the write.</div>
          </form>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader kicker="CAST" title={`Characters — ${characters.length}`} />
            {characters.length===0 ? <div className="text-sm text-[#6B7594]">No characters yet.</div> : (
              <div className="space-y-2">{characters.map(c=>(
                <div key={c.id} className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-[#0F1425] px-3 py-2.5">
                  <div><div className="text-[13px] font-semibold text-white">{c.name}</div><div className="text-[12px] text-[#6B7594]">{c.role ?? "—"} {c.description ? `· ${c.description.slice(0,60)}` : ""}</div></div>
                  <button onClick={async()=>{ await fetch(apiUrl(`/api/characters/${c.id}`), { method:"DELETE" }); load(); }} className="rounded-full border border-white/10 px-3 py-1 text-[11px] text-zinc-300 hover:bg-white/10">Delete</button>
                </div>
              ))}</div>
            )}
            <form onSubmit={addCharacter} className="mt-3 flex gap-2">
              <input value={charName} onChange={e=>setCharName(e.target.value)} placeholder="Name — e.g. Kai" className="min-w-0 flex-1 rounded-full border border-white/10 bg-[#070A14] px-3 py-2 text-[13px] text-white placeholder:text-zinc-500"/>
              <input value={charRole} onChange={e=>setCharRole(e.target.value)} placeholder="Role" className="w-28 rounded-full border border-white/10 bg-[#070A14] px-3 py-2 text-[13px] text-white placeholder:text-zinc-500"/>
              <button type="submit" className="rounded-full bg-[#FF4D5A] px-4 py-2 text-[13px] font-semibold text-white">Add</button>
            </form>
          </Card>
          <Card>
            <CardHeader kicker="WORLD" title={`Locations — ${locations.length}`} />
            {locations.length===0 ? <div className="text-sm text-[#6B7594]">No locations yet.</div> : (
              <div className="space-y-2">{locations.map(l=>(
                <div key={l.id} className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-[#0F1425] px-3 py-2.5">
                  <div><div className="text-[13px] font-semibold text-white">{l.name}</div><div className="text-[12px] text-[#6B7594]">{l.description?.slice(0,60) ?? "—"}</div></div>
                  <button onClick={async()=>{ await fetch(apiUrl(`/api/locations/${l.id}`), { method:"DELETE" }); load(); }} className="rounded-full border border-white/10 px-3 py-1 text-[11px] text-zinc-300 hover:bg-white/10">Delete</button>
                </div>
              ))}</div>
            )}
            <form onSubmit={addLocation} className="mt-3 flex gap-2">
              <input value={locName} onChange={e=>setLocName(e.target.value)} placeholder="Location — e.g. Abandoned city" className="min-w-0 flex-1 rounded-full border border-white/10 bg-[#070A14] px-3 py-2 text-[13px] text-white placeholder:text-zinc-500"/>
              <input value={locDesc} onChange={e=>setLocDesc(e.target.value)} placeholder="Note" className="w-28 rounded-full border border-white/10 bg-[#070A14] px-3 py-2 text-[13px] text-white placeholder:text-zinc-500"/>
              <button type="submit" className="rounded-full bg-[#FF4D5A] px-4 py-2 text-[13px] font-semibold text-white">Add</button>
            </form>
          </Card>
        </div>

        <Card>
          <CardHeader kicker="EPISODES" title={`${episodes.length} episodes`} />
          {episodes.length===0 ? <div className="text-sm text-[#6B7594]">No episodes yet — create one from <Link href="/projects" className="text-white underline">Projects</Link>.</div> : (
            <div className="space-y-2">{episodes.map(e=>(
              <Link key={e.id} href={`/episodes/${e.id}`} className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-[#0F1425] px-3 py-2.5 hover:bg-white/[0.06]">
                <div><span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-bold text-[#070A14]">EP {String(e.number).padStart(2,"0")}</span> <span className="ml-2 text-[13px] font-semibold text-white">{e.title}</span></div>
                <Badge>{e.status}</Badge>
              </Link>
            ))}</div>
          )}
        </Card>
      </main>
    </div>
  );
}
