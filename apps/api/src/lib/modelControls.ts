// apps/api/src/lib/modelControls.ts
// Reads the persisted per-model on/off switches. Used by the runtime supervisor so a model the
// operator switched OFF is never started — the refusal is recorded truthfully, not faked.
//
// Fail-open by design: if `model_controls` is missing (migration 004 not applied) or the database
// is unreachable, we do NOT silently refuse all work — we report `unknown` so the caller can still
// proceed, and the reason is visible in the response.

import type { SupabaseClient } from "@supabase/supabase-js";
import { modelForProvider } from "@ostra/shared";

export type ModelDisabledCheck = {
  /** The catalog entry for this provider slot, or null when the slot is not switchable. */
  switchable: boolean;
  /** True only when a stored row says `enabled = false`. */
  disabled: boolean;
  /** Reason the switch state could not be read (table missing / DB error). Never a secret. */
  unknownReason?: string;
};

/**
 * Is the model behind this provider slot switched off?
 * `providerSlot` is the registry slot / worker type: script | image | voice | video | youtube.
 */
export async function checkModelDisabled(
  supa: SupabaseClient | null,
  providerSlot: string | null | undefined
): Promise<ModelDisabledCheck> {
  const entry = modelForProvider(providerSlot);
  if (!entry) return { switchable: false, disabled: false };
  if (!supa) return { switchable: true, disabled: false, unknownReason: "Supabase not configured" };
  try {
    const { data, error } = await supa
      .from("model_controls")
      .select("enabled")
      .eq("provider_id", entry.providerId)
      .maybeSingle();
    if (error) {
      return { switchable: true, disabled: false, unknownReason: error.message };
    }
    const row = data as { enabled?: boolean } | null;
    return { switchable: true, disabled: row ? row.enabled === false : false };
  } catch (e) {
    return {
      switchable: true,
      disabled: false,
      unknownReason: e instanceof Error ? e.message : String(e),
    };
  }
}
