// apps/api/src/lib/routing.ts
// Reads and writes the persisted provider routing decision (which model family answers each agent).
//
// Fail-open by design, exactly like modelControls.ts: when `provider_routing` is missing (migration
// 009 not applied) or the database is unreachable we do NOT refuse all work — we fall back to the
// shipped default (`auto`) and report WHY in `reason`, so the UI can say the setting could not be
// read instead of inventing one.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_ROUTING,
  isRoutableSlot,
  isRoutingMode,
  normalizeRoutingMode,
  normalizeRoutingSlots,
  type RoutingMode,
  type RoutingSettings,
  type RoutableSlot,
} from "@ostra/shared";

export const ROUTING_TABLE = "provider_routing";

export type RoutingRead = { settings: RoutingSettings; reason?: string };

/** Read the single routing row. Never throws; a failure degrades to the default with a real reason. */
export async function readRouting(supa: SupabaseClient | null): Promise<RoutingRead> {
  if (!supa) {
    return { settings: DEFAULT_ROUTING, reason: "Supabase is not configured on the backend — routing defaults to auto" };
  }
  try {
    const { data, error } = await supa.from(ROUTING_TABLE).select("mode, slots, updated_by, updated_at").eq("id", 1).maybeSingle();
    if (error) return { settings: DEFAULT_ROUTING, reason: error.message };
    const row = data as { mode?: unknown; slots?: unknown; updated_by?: string | null; updated_at?: string | null } | null;
    if (!row) return { settings: DEFAULT_ROUTING };
    return {
      settings: {
        mode: normalizeRoutingMode(row.mode),
        slots: normalizeRoutingSlots(row.slots),
        updatedAt: row.updated_at ?? null,
        updatedBy: row.updated_by ?? null,
      },
    };
  } catch (e) {
    return { settings: DEFAULT_ROUTING, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Result of validating a PATCH /api/routing body. Pure, so the HTTP rules are unit-testable. */
export type RoutingPatchValidation =
  | { ok: true; mode?: RoutingMode; slot?: RoutableSlot; slotMode?: RoutingMode | null }
  | { ok: false; status: number; error: string; known?: readonly string[] };

/**
 * Validate the operator's routing change. Deliberately strict: an unknown mode or slot is a 400 that
 * names what IS accepted, so a typo can never change routing in a way nobody can see.
 */
export function validateRoutingPatch(body: unknown): RoutingPatchValidation {
  const b = (body ?? {}) as { mode?: unknown; slot?: unknown; slotMode?: unknown };
  const hasMode = b.mode !== undefined && b.mode !== null;
  const hasSlot = b.slot !== undefined && b.slot !== null;
  const hasSlotMode = b.slotMode !== undefined;

  if (!hasMode && !hasSlot) {
    return { ok: false, status: 400, error: "Provide `mode`, or `slot` + `slotMode`" };
  }
  let mode: RoutingMode | undefined;
  if (hasMode) {
    if (!isRoutingMode(typeof b.mode === "string" ? b.mode.trim().toLowerCase() : b.mode)) {
      return { ok: false, status: 400, error: `mode must be one of own | auto | nvidia`, known: ["own", "auto", "nvidia"] };
    }
    mode = (b.mode as string).trim().toLowerCase() as RoutingMode;
  }
  if (!hasSlot) return { ok: true, mode };

  const slot = typeof b.slot === "string" ? b.slot.trim().toLowerCase() : "";
  if (!isRoutableSlot(slot)) {
    return { ok: false, status: 400, error: `slot must be one of script | image | voice | overseer | manager`, known: ["script", "image", "voice", "overseer", "manager"] };
  }
  if (!hasSlotMode) return { ok: false, status: 400, error: "Provide `slotMode` (own | auto | nvidia, or null to inherit)" };
  if (b.slotMode === null) return { ok: true, mode, slot, slotMode: null };
  const raw = typeof b.slotMode === "string" ? b.slotMode.trim().toLowerCase() : b.slotMode;
  if (!isRoutingMode(raw)) {
    return { ok: false, status: 400, error: "slotMode must be one of own | auto | nvidia, or null", known: ["own", "auto", "nvidia"] };
  }
  return { ok: true, mode, slot, slotMode: raw as RoutingMode };
}

/** Apply a validated patch to the current settings — pure, so the merge rule is testable. */
export function applyRoutingPatch(
  current: RoutingSettings,
  patch: Extract<RoutingPatchValidation, { ok: true }>
): { mode: RoutingMode; slots: Partial<Record<RoutableSlot, RoutingMode>> } {
  const slots = { ...current.slots };
  if (patch.slot) {
    if (patch.slotMode === null) delete slots[patch.slot];
    else slots[patch.slot] = patch.slotMode;
  }
  return { mode: patch.mode ?? current.mode, slots };
}

/** Persist the decision. Returns the saved settings or the real database error. */
export async function saveRouting(
  supa: SupabaseClient,
  next: { mode: RoutingMode; slots: Partial<Record<RoutableSlot, RoutingMode>> },
  actor: string
): Promise<{ ok: true; settings: RoutingSettings } | { ok: false; error: string }> {
  const updatedAt = new Date().toISOString();
  const { error } = await supa
    .from(ROUTING_TABLE)
    .upsert({ id: 1, mode: next.mode, slots: next.slots, updated_by: actor, updated_at: updatedAt }, { onConflict: "id" });
  if (error) return { ok: false, error: error.message };
  return { ok: true, settings: { mode: next.mode, slots: next.slots, updatedAt, updatedBy: actor } };
}
