"use client";

import { PIPELINE_ORDER, type PipelineStep } from "@ostra/shared";

const LABEL: Record<PipelineStep, string> = {
  IDEA: "IDEA",
  SCRIPT: "SCRIPT",
  SCENES: "SCENES",
  IMAGES: "IMAGES",
  VOICE: "VOICE",
  VIDEO: "VIDEO",
  QC: "QC",
  REVIEW: "HUMAN REVIEW",
  YOUTUBE: "YOUTUBE",
};

export function Pipeline({ active, completedCount }: { active: PipelineStep; completedCount?: number }) {
  const activeIdx = PIPELINE_ORDER.indexOf(active);
  const doneUntil = typeof completedCount === "number" ? completedCount - 1 : activeIdx - 1;
  return (
    <div className="flex items-center gap-1 overflow-x-auto py-1">
      {PIPELINE_ORDER.map((step, i) => {
        const isActive = i === activeIdx;
        const isDone = i <= doneUntil;
        const isPast = i < activeIdx;
        return (
          <div key={step} className="flex items-center gap-1">
            <div
              className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-bold tracking-widest transition
                ${isActive ? "border-[#FF4D5A] bg-[#FF4D5A] text-white shadow-[0_6px_16px_rgba(255,77,90,0.4)]" : ""}
                ${!isActive && isDone ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-200" : ""}
                ${!isActive && !isDone && isPast ? "border-white/10 bg-white/[0.04] text-zinc-400" : ""}
                ${!isActive && !isDone && !isPast ? "border-white/[0.07] bg-white/[0.03] text-[#6B7594]" : ""}
              `}
              title={step}
            >
              {isDone && !isActive ? "✓ " : ""}{LABEL[step]}
            </div>
            {i < PIPELINE_ORDER.length - 1 && (
              <div className={`h-px w-3 shrink-0 ${i < activeIdx ? "bg-emerald-500/30" : "bg-white/10"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function PipelineCompact({ step }: { step: PipelineStep }) {
  const idx = PIPELINE_ORDER.indexOf(step);
  return (
    <div className="flex items-center gap-1">
      <span className="label-mono text-[#6B7594]">PIPELINE</span>
      <span className="text-[11px] text-zinc-500">—</span>
      <span className="rounded-full bg-[#FF4D5A] px-2 py-0.5 text-[11px] font-bold tracking-wide text-white">{step}</span>
      <span className="text-[11px] text-zinc-500">{idx + 1}/{PIPELINE_ORDER.length}</span>
    </div>
  );
}
