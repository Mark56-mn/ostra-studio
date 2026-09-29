"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/", label: "Studio" },
  { href: "/projects", label: "Projects" },
  { href: "/runner", label: "Runner" },
  { href: "/models", label: "Models" },
  { href: "/runtimes", label: "Runtimes" },
  { href: "/agents", label: "Agents" },
  { href: "/activity", label: "Activity" },
];

export function TopNav() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-[#070A14]/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1100px] items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#FF4D5A] text-[13px] font-black tracking-tighter text-white">OS</div>
          <div className="leading-none">
            <div className="text-[13px] font-bold tracking-tight text-white">OSTRA STUDIO</div>
            <div className="text-[10px] font-medium tracking-[0.14em] text-[#6B7594]">MANHWA • PRODUCTION</div>
          </div>
        </Link>
        <nav className="hidden items-center gap-1 sm:flex">
          {NAV.map((i) => {
            const active = pathname === i.href || (i.href !== "/" && pathname.startsWith(i.href));
            return (
              <Link
                key={i.href}
                href={i.href}
                className={`rounded-full px-3.5 py-1.5 text-[13px] font-medium transition ${active ? "bg-white text-[#070A14]" : "text-zinc-400 hover:bg-white/10 hover:text-white"}`}
              >
                {i.label}
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-2">
          <span className="hidden items-center gap-1.5 rounded-full border border-amber-500/25 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-300 sm:inline-flex">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> AUTO_PUBLISH OFF
          </span>
          <Link href="/projects" className="rounded-full bg-[#FF4D5A] px-4 py-2 text-[13px] font-semibold text-white shadow-[0_8px_20px_rgba(255,77,90,0.35)] hover:bg-[#ff5e6a]">
            Open studio
          </Link>
        </div>
      </div>
      {/* mobile nav */}
      <div className="flex gap-1 overflow-x-auto border-t border-white/[0.06] px-2 py-2 sm:hidden">
        {NAV.map((i) => {
          const active = pathname === i.href || (i.href !== "/" && pathname.startsWith(i.href));
          return (
            <Link
              key={i.href}
              href={i.href}
              className={`shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-medium ${active ? "bg-white text-[#070A14]" : "bg-white/[0.06] text-zinc-300"}`}
            >
              {i.label}
            </Link>
          );
        })}
      </div>
    </header>
  );
}
