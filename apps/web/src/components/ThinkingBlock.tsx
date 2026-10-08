"use client";
// apps/web/src/components/ThinkingBlock.tsx
// The director asked to SEE what the agents are thinking. This renders the model's own reasoning for
// one turn — the trace the model actually produced, kept visually separate from its answer so it can
// never be mistaken for one.
//
// Truth rules:
//  - Nothing is invented: a model that produced no reasoning renders NOTHING (no empty box, no
//    placeholder text). The count is of real words in the real trace.
//  - It is expanded by default, because "hidden behind a click" is the same as hidden for a director
//    reading a conversation. It stays collapsible for long traces, and the open state survives the
//    transcript's live polling while the row keeps its `key` (the message id).

import { useState } from "react";

export function reasoningWordCount(reasoning: string | null | undefined): number {
  const text = (reasoning ?? "").trim();
  return text ? text.split(/\s+/).length : 0;
}

export function ThinkingBlock({
  reasoning,
  /** Where the trace came from, e.g. "reasoning, not the answer" / "reasoning, not the message". */
  caption = "the model's own reasoning — not the answer",
}: {
  reasoning: string | null | undefined;
  caption?: string;
}) {
  const [open, setOpen] = useState(true);
  const words = reasoningWordCount(reasoning);
  if (words === 0) return null;

  const text = (reasoning ?? "").trim();
  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="group mb-2 rounded-lg border border-amber-400/20 bg-[#070A14]/70"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-[11px] text-[#8B94B4] transition hover:text-[#C7CEE4] [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="text-[9px] transition-transform group-open:rotate-90">
          ▶
        </span>
        <span className="label-mono text-amber-300/90">THINKING</span>
        <span className="text-[#6B7594]">
          · {words} words — {caption}
        </span>
      </summary>
      <div className="max-h-72 overflow-y-auto whitespace-pre-wrap border-t border-amber-400/15 px-2.5 py-2 font-mono text-[11px] leading-5 text-[#C7CEE4]">
        {text}
      </div>
    </details>
  );
}
