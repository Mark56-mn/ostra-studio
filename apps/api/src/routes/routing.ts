// apps/api/src/routes/routing.ts
// The provider switch: WHICH model family answers each agent.
//
//   GET   /api/routing   → the stored decision + what each slot will ACTUALLY answer from right now
//   PATCH /api/routing   → { mode } or { slot, slotMode } → persist the decision (audited)
//
// Honesty rules:
//  - The per-slot rows are not a restatement of the setting: each one is the same resolution the
//    room/channel uses when it calls a model (`resolveChannelBackend`), so what the page shows is what
//    will happen. A slot that cannot be routed anywhere says so, by name.
//  - Selecting NVIDIA does NOT make it ONLINE: a real (briefly cached) completion is the only thing
//    that proves the backup works, and its result is reported verbatim.
//  - The base URL is never returned — only its host — and the API key never leaves the backend.

import type { Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  NVIDIA_MODEL_CATALOG,
  ROUTABLE_SLOTS,
  nvidiaConfig,
  routingModeFor,
  type RoutableSlot,
} from "@ostra/shared";
import { requireSupabase } from "../lib/supabase.js";
import { applyRoutingPatch, readRouting, saveRouting, validateRoutingPatch } from "../lib/routing.js";
import { nvidiaBackend, probeHostedModel, resolveChannelBackend } from "../lib/agentRuntime.js";

type SlotView = {
  slot: RoutableSlot;
  mode: string;
  available: boolean;
  kind: string | null;
  provider: string | null;
  model: string | null;
  endpointHost: string | null;
  detail: string;
};

/** What each slot would answer from right now, using the same resolver the agents use. */
async function slotViews(supa: SupabaseClient): Promise<SlotView[]> {
  return Promise.all(
    ROUTABLE_SLOTS.map(async (slot): Promise<SlotView> => {
      const { backend, status } = await resolveChannelBackend(supa, slot);
      return {
        slot,
        mode: routingModeFor((await readRouting(supa)).settings, slot),
        available: status.available && backend !== null,
        kind: status.kind,
        provider: status.provider,
        model: status.model,
        endpointHost: status.endpointHost,
        detail: status.detail,
      };
    })
  );
}

/** The full control-plane view. Never throws for a provider problem — the problem is the payload. */
async function routingPayload(supa: SupabaseClient) {
  const { settings, reason } = await readRouting(supa);
  const cfg = nvidiaConfig();
  // A real completion, cached for a minute: the only honest evidence the backup works.
  const health = cfg.configured ? await probeHostedModel(nvidiaBackend("script"), { timeoutMs: 8000 }) : null;
  const slots = await slotViews(supa);
  return {
    settings,
    /** Set when the stored decision could not be read (routing then falls back to `auto`). */
    read_reason: reason ?? null,
    nvidia: {
      configured: cfg.configured,
      /** Host only — the URL is server-side. */
      host: cfg.host,
      model: cfg.model,
      /** Is reasoning requested for models that document a switch? */
      thinking: cfg.thinking,
      reason: cfg.reason ?? null,
      health,
      catalog: NVIDIA_MODEL_CATALOG.map((m) => ({ id: m.id, label: m.label, thinking: m.thinkingKwargs !== null, note: m.note })),
    },
    slots,
    timestamp: new Date().toISOString(),
  };
}

/** GET /api/routing */
export async function getRouting(_req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  res.json(await routingPayload(supa));
}

/** PATCH /api/routing — persist the operator's decision and record it (constraint 20: auditable). */
export async function setRouting(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;

  const validated = validateRoutingPatch(req.body);
  if (!validated.ok) {
    return res.status(validated.status).json({ error: validated.error, ...(validated.known ? { known: validated.known } : {}) });
  }

  const body = req.body as { updated_by?: unknown } | null;
  const actor =
    (typeof body?.updated_by === "string" && body.updated_by.trim()) ||
    (typeof req.headers["x-operator"] === "string" && req.headers["x-operator"]) ||
    "dashboard";

  const current = await readRouting(supa);
  const next = applyRoutingPatch(current.settings, validated);
  const saved = await saveRouting(supa, next, actor);
  if (!saved.ok) return res.status(400).json({ error: saved.error });

  await supa
    .from("events")
    .insert({
      type: "routing.changed",
      actor,
      payload: {
        mode: next.mode,
        slots: next.slots,
        slot: validated.slot ?? null,
        slot_mode: validated.slotMode ?? null,
        read_reason: current.reason ?? null,
      },
    })
    .then(
      () => undefined,
      () => undefined
    );

  res.json({ ...(await routingPayload(supa)), changed: { mode: next.mode, slots: next.slots }, actor });
}
