type Variant = "online" | "offline" | "warn" | "muted" | "idle" | "working";

const map: Record<Variant, string> = {
  online:  "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  offline: "bg-red-500/10 text-red-300 border-red-500/25",
  warn:    "bg-amber-500/12 text-amber-300 border-amber-500/25",
  working: "bg-sky-500/12 text-sky-300 border-sky-500/25",
  idle:    "bg-white/[0.06] text-zinc-300 border-white/10",
  muted:   "bg-white/[0.04] text-[#6B7594] border-white/[0.06]",
};

export function Badge({ variant = "muted", children, dot }: { variant?: Variant; children: React.ReactNode; dot?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium leading-none tracking-wide ${map[variant]}`}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />}
      {children}
    </span>
  );
}

export function statusVariant(s: string): Variant {
  const t = (s ?? "UNKNOWN").toUpperCase();
  if (["ONLINE","COMPLETED","APPROVED","PUBLISHED","IDLE"].includes(t)) return "online";
  if (["OFFLINE","FAILED","REJECTED","CANCELLED","ERROR"].includes(t)) return "offline";
  if (["WORKING","QUEUED","RETRYING","RENDERING","UPLOADING","QC","REVIEW"].includes(t)) return "working";
  if (["CONNECTING","PENDING","WAITING","STARTING","DEGRADED","CHANGES_REQUESTED"].includes(t)) return "warn";
  if (["NOT_CONFIGURED"].includes(t)) return "warn";
  return "muted";
}
