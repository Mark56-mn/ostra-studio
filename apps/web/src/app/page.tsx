import Link from "next/link";
import { TopNav } from "@/components/TopNav";
import { ProviderStatus } from "@/components/ProviderStatus";

export default function Home() {
  return (
    <div className="min-h-screen bg-[#070A14]">
      <TopNav />

      {/* HERO */}
      <section className="relative overflow-hidden">
        {/* ink wash */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -top-32 -left-32 h-[520px] w-[720px] rounded-full bg-[#FF4D5A]/[0.11] blur-[80px]" />
          <div className="absolute -top-20 right-0 h-[480px] w-[560px] rounded-full bg-[#3DE0B3]/[0.07] blur-[70px]" />
          <div className="absolute bottom-0 left-1/2 h-[420px] w-[900px] -translate-x-1/2 rounded-full bg-[#7C5CFF]/[0.06] blur-[80px]" />
          {/* paper grain */}
          <div className="absolute inset-0 opacity-[0.035]" style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.4'/%3E%3C/svg%3E")` }} />
        </div>

        <div className="relative mx-auto max-w-[1100px] px-4 pb-10 pt-10 sm:px-6 sm:pt-16">
          <div className="inline-flex flex-wrap items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 backdrop-blur">
            <span className="text-[11px] font-semibold tracking-[0.14em] text-zinc-300">NO MOCKS · REAL WORKERS · HUMAN APPROVAL</span>
            <span className="hidden text-[11px] text-[#6B7594] sm:inline">• live provider state below</span>
          </div>

          <div className="mt-6 grid gap-8 lg:grid-cols-[1.15fr_0.85fr] lg:items-start">
            <div>
              <h1 className="text-balance text-[40px] font-bold leading-[0.95] tracking-[-0.03em] text-white sm:text-[56px]">
                Where <span className="bg-gradient-to-r from-[#FF4D5A] to-[#FF8A5A] bg-clip-text text-transparent">manhwa</span>
                <br /> becomes video.
              </h1>
              <p className="mt-4 max-w-[56ch] text-[15px] leading-7 text-[#9AA3C0] sm:text-[16px]">
                Ostra Studio is the production control plane for original manhwa on YouTube. Specialized AI workers write, draw, speak and cut — you stay the director and give the final <span className="font-semibold text-white">approve</span> before anything goes public.
              </p>

              <div className="mt-6 flex flex-wrap gap-3">
                <Link href="/projects" className="inline-flex items-center gap-2 rounded-full bg-[#FF4D5A] px-6 py-3 text-[14px] font-semibold text-white shadow-[0_12px_28px_rgba(255,77,90,0.35)] transition hover:bg-[#ff5e6a]">
                  Enter studio <span aria-hidden>→</span>
                </Link>
                <Link href="/runner" className="inline-flex items-center rounded-full border border-[#FF4D5A]/30 bg-[#FF4D5A]/10 px-6 py-3 text-[14px] font-semibold text-[#FF8A93] backdrop-blur transition hover:bg-[#FF4D5A]/20">
                  Run an AI now
                </Link>
                <Link href="/chat" className="inline-flex items-center gap-2 rounded-full border border-[#3DE0B3]/30 bg-[#3DE0B3]/10 px-6 py-3 text-[14px] font-semibold text-[#7FF0CE] backdrop-blur transition hover:bg-[#3DE0B3]/20">
                  Chat with the agent <span aria-hidden>→</span>
                </Link>
                <Link href="/agents" className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.06] px-6 py-3 text-[14px] font-semibold text-white backdrop-blur hover:bg-white/10">
                  Check Agent Room
                </Link>
              </div>

              <div className="mt-6 flex flex-wrap gap-2 text-[11px]">
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 font-medium tracking-wide text-zinc-300">AUTO_PUBLISH OFF by default</span>
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 font-medium tracking-wide text-zinc-300">Artifacts are versioned</span>
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 font-medium tracking-wide text-zinc-300">Provider adapters</span>
              </div>

              {/* mini pipeline strip */}
              <div className="mt-8 rounded-2xl border border-white/[0.06] bg-[#0F1425]/80 p-3 backdrop-blur">
                <div className="label-mono mb-2 text-[#6B7594]">PRODUCTION PIPELINE — tap any stage in the studio</div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {["IDEA","SCRIPT","SCENES","IMAGES","VOICE","VIDEO","QC","REVIEW","YOUTUBE"].map((s, i) => (
                    <span key={s} className="flex items-center gap-1.5">
                      <span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold tracking-widest ${i===0 ? "border-[#FF4D5A] bg-[#FF4D5A] text-white" : "border-white/10 bg-white/[0.03] text-zinc-400"}`}>{s}</span>
                      {i < 8 && <span className="text-white/20">›</span>}
                    </span>
                  ))}
                </div>
                <div className="mt-2 text-[12px] leading-5 text-[#6B7594]">
                  Failed work never destroys successful work. Every important action is audited.
                </div>
              </div>
            </div>

            {/* right — episode card + worker stack */}
            <div className="space-y-4">
              <div className="overflow-hidden rounded-[20px] border border-white/[0.08] bg-gradient-to-br from-[#131A32] to-[#0F1425] p-0 shadow-[0_20px_60px_rgba(0,0,0,0.5)]">
                <div className="relative aspect-[16/10] overflow-hidden bg-[#0B1022]">
                  <div className="absolute inset-0 bg-gradient-to-br from-[#FF4D5A]/20 via-transparent to-[#3DE0B3]/15" />
                  <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_20%,rgba(255,255,255,0.08),transparent_55%)]" />
                  {/* manhwa-style vertical panels */}
                  <div className="absolute inset-0 grid grid-cols-3 gap-2 p-4 opacity-60">
                    <div className="rounded-xl bg-white/[0.06] ring-1 ring-white/10" />
                    <div className="rounded-xl bg-white/[0.04] ring-1 ring-white/10" />
                    <div className="rounded-xl bg-white/[0.08] ring-1 ring-white/10" />
                  </div>
                  <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-4">
                    <div className="inline-flex items-center gap-2 rounded-full bg-[#FF4D5A] px-2.5 py-1 text-[10px] font-bold tracking-widest text-white">EXAMPLE LAYOUT · UI PREVIEW</div>
                    <div className="mt-2 text-[15px] font-semibold leading-tight text-white">The review gate</div>
                    <div className="text-[12px] text-white/70">Illustrative only — your real episodes live in Projects</div>
                  </div>
                  <div className="absolute right-3 top-3 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur">16:9 • 1080p</div>
                </div>
                <div className="flex items-center justify-between gap-3 p-4">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-amber-400" />
                    <span className="text-[12px] font-medium text-zinc-300">Nothing publishes without you</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Link href="/chat" className="rounded-full bg-white px-4 py-2 text-[12px] font-semibold text-[#070A14]">Agent Chat</Link>
                    <Link href="/agents" className="rounded-full border border-white/15 bg-white/[0.06] px-4 py-2 text-[12px] font-semibold text-white">Agent Room</Link>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-white/[0.06] bg-[#0F1425] p-3">
                <div className="label-mono mb-2 text-[#6B7594]">LIVE PROVIDER STATE — FROM THE RENDER API</div>
                <ProviderStatus compact pollMs={20_000} />
              </div>
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 text-[12px] leading-5 text-[#9AA3C0]">
                Script AI autostarts by pushing <span className="font-mono text-[11px] text-white">bettertrade/notebook7eae283a4a</span> to Kaggle, then waits for the worker to <span className="text-white">register</span> and <span className="text-white">heartbeat</span>. Image, Voice and the Showrunner run as their own Kaggle notebooks on <span className="text-white">Qwen3 4B</span>, so they report whatever their worker actually did &mdash; no notebook session means <span className="text-white">OFFLINE</span>, never a pretend ONLINE. Configuration alone never becomes ONLINE.
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* FEATURE STRIP */}
      <section className="mx-auto max-w-[1100px] px-4 pb-6 sm:px-6">
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            { title: "Director, not passenger", body: "Every episode waits at the review gate. Approve, reject, or ask for changes — nothing publishes without you unless you flip AUTO_PUBLISH on.", accent: "border-[#FF4D5A]/25" },
            { title: "Adapters, not lock-in", body: "Script, Image, Voice and Video are capability contracts. Kaggle and Colab are starting runtimes, not permanent dependencies. Swap providers without rewiring workflow.", accent: "border-[#3DE0B3]/25" },
            { title: "Mobile-first control", body: "Approve a cut from your phone on the train. Touch targets, readable type, and video preview built for Android first.", accent: "border-white/10" },
          ].map((f) => (
            <div key={f.title} className={`rounded-2xl border bg-[#0F1425]/70 p-4 backdrop-blur ${f.accent}`}>
              <div className="text-[13px] font-semibold text-white">{f.title}</div>
              <div className="mt-1.5 text-[13px] leading-6 text-[#9AA3C0]">{f.body}</div>
            </div>
          ))}
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="mx-auto max-w-[1100px] px-4 py-8 sm:px-6">
        <div className="label-mono text-[#6B7594]">HOW IT WORKS — THE HONEST VERSION</div>
        <div className="mt-3 grid gap-3 lg:grid-cols-12">
          <div className="rounded-2xl border border-white/[0.06] bg-[#131A32]/60 p-5 lg:col-span-7">
            <ol className="space-y-3 text-[13px] leading-6 text-[#C2CBE6]">
              <li className="flex gap-3"><span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white text-[11px] font-bold text-[#070A14]">1</span><span><span className="font-semibold text-white">You bring the story.</span> A logline, a premise, a world. The story bible (characters, locations, world rules) persists across episodes so continuity doesn&apos;t drift.</span></li>
              <li className="flex gap-3"><span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-[11px] font-bold text-white">2</span><span><span className="font-semibold text-white">Workers produce artifacts.</span> Script AI breaks scenes, Image AI draws them, Voice AI speaks them, FFmpeg cuts the video. Each step is a task with dependencies, retries, and versioned outputs.</span></li>
              <li className="flex gap-3"><span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-[11px] font-bold text-white">3</span><span><span className="font-semibold text-white">You approve.</span> The orchestrator holds the gate at <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[11px]">READY_FOR_REVIEW</span>. Approved videos queue for YouTube; rejected ones branch into revisions. Failed tasks never nuke good artifacts.</span></li>
            </ol>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href="/projects" className="rounded-full bg-white px-4 py-2 text-[12px] font-semibold text-[#070A14]">Create your first project</Link>
              <Link href="/activity" className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-[12px] font-semibold text-white">See the audit log</Link>
            </div>
          </div>
          <div className="rounded-2xl border border-white/[0.06] bg-[#0F1425] p-5 lg:col-span-5">
            <div className="text-[12px] font-semibold tracking-wide text-white">WHAT&apos;S REAL TODAY</div>
            <div className="mt-3 space-y-2 text-[12px] leading-5">
              <div className="flex items-center justify-between rounded-xl bg-white/[0.04] px-3 py-2"><span className="text-zinc-300">Domain &amp; schema</span><span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">SHIPPED</span></div>
              <div className="flex items-center justify-between rounded-xl bg-white/[0.04] px-3 py-2"><span className="text-zinc-300">Orchestrator state</span><span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">SHIPPED</span></div>
              <div className="flex items-center justify-between rounded-xl bg-white/[0.04] px-3 py-2"><span className="text-zinc-300">Provider contracts</span><span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">SHIPPED</span></div>
              <div className="flex items-center justify-between rounded-xl bg-white/[0.04] px-3 py-2"><span className="text-zinc-300">Supabase migrations</span><span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">SHIPPED</span></div>
              <div className="flex items-center justify-between rounded-xl bg-white/[0.04] px-3 py-2"><span className="text-zinc-300">Runtime supervisor (leases)</span><span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">SHIPPED</span></div>
              <div className="flex items-center justify-between rounded-xl bg-white/[0.04] px-3 py-2"><span className="text-zinc-300">Script AI (Kaggle) autostart</span><span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-300">WIRED</span></div>
              <div className="flex items-center justify-between rounded-xl bg-white/[0.04] px-3 py-2"><span className="text-zinc-300">Agent Chat → store writes</span><span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">SHIPPED</span></div>
              <div className="flex items-center justify-between rounded-xl bg-white/[0.04] px-3 py-2"><span className="text-zinc-300">Image / Voice (Colab)</span><span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-zinc-400">PENDING</span></div>
              <div className="flex items-center justify-between rounded-xl bg-white/[0.04] px-3 py-2"><span className="text-zinc-300">FFmpeg render</span><span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-zinc-400">PHASE 7</span></div>
              <div className="flex items-center justify-between rounded-xl bg-white/[0.04] px-3 py-2"><span className="text-zinc-300">YouTube upload</span><span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-zinc-400">PHASE 9</span></div>
            </div>
            <div className="mt-3 text-[11px] leading-5 text-[#6B7594]">Live availability is never asserted here — open the <Link href="/agents" className="text-white underline decoration-white/30 underline-offset-2">Agent Room</Link> for the real Render / Supabase / provider state.</div>
          </div>
        </div>
      </section>

      <footer className="border-t border-white/[0.06] py-8">
        <div className="mx-auto flex max-w-[1100px] flex-wrap items-center justify-between gap-3 px-4 text-[12px] text-[#6B7594] sm:px-6">
          <span>© Ostra Studio — AGPL-3.0 • Every important action is audited. Secrets never ship to the browser.</span>
          <span className="font-mono text-[11px]">AUTO_PUBLISH=false</span>
        </div>
      </footer>
    </div>
  );
}
