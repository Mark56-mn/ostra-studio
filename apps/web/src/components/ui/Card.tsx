export function Card({ children, className = "", padding = true }: { children: React.ReactNode; className?: string; padding?: boolean }) {
  return (
    <div className={`rounded-2xl border border-white/[0.07] bg-[#131A32]/80 backdrop-blur ${padding ? "p-4 sm:p-5" : ""} ${className}`}>
      {children}
    </div>
  );
}
export function CardHeader({ kicker, title, action }: { kicker?: string; title: string; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div>
        {kicker && <div className="label-mono text-[#6B7594]">{kicker}</div>}
        <div className="text-[15px] font-semibold tracking-tight text-white">{title}</div>
      </div>
      {action}
    </div>
  );
}
