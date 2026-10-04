import type { Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MODEL_CATALOG,
  findModel,
  liveModelFromHealth,
  modelDispatchState,
  resolveStoredModelKey,
  type ModelView,
  type ProviderHealth,
} from "@ostra/shared";
import { getServerSupabase, requireSupabase, supabaseConfigReason } from "../lib/supabase.js";
import { buildHealthReport } from "../lib/providerHealth.js";

// Model switches — the operator's on/off intent for each AI model.
//
//   GET   /api/models         → catalog + stored switch + REAL derived health per model
//   PATCH /api/models/:key    → { enabled: boolean, note?: string } → persist the switch
//
// Honesty rules (see packages/shared/src/providers/models.ts):
//  - The toggle changes intent only. `health` is always the real, derived status, so switching a
//    model off never makes it look ONLINE, and switching it on never makes it look usable.
//  - `dispatch` is the derived answer to "will the orchestrator actually use it right now?".
//  - There is no synthetic fallback list: if Supabase cannot be read we say so explicitly (503)
//    instead of pretending every toggle is on.
//  - A model with no stored row is ON (the code default), so nothing has to be seeded.

export type ControlRow = {
  key: string;
  enabled: boolean | null;
  note: string | null;
  updated_by: string | null;
  updated_at: string | null;
};

const CONTROL_COLUMNS = "key,enabled,note,updated_by,updated_at";

/** Provider health keyed by registry slot, as returned by buildHealthReport().providers. */
export type ProviderHealthMap = Record<string, { health?: ProviderHealth } | undefined> | null | undefined;

/**
 * Pure merge of the static catalog + stored switches + real provider health into ModelViews.
 * Extracted so the rules (default ON, dispatch derivation, health passthrough) are unit-testable
 * without a database or a live provider check.
 */
export function mergeModelViews(controls: ControlRow[], providers: ProviderHealthMap): ModelView[] {
  // A switch stored under a retired key still counts for the entry that replaced it, so the model
  // upgrade did not silently drop an operator's ON/OFF decision. A current key always wins.
  const byKey = new Map<string, ControlRow>();
  const catalogKeys = new Set(MODEL_CATALOG.map((m) => m.key));
  for (const row of controls) {
    const exact = row.key.trim().toLowerCase();
    if (catalogKeys.has(exact)) {
      byKey.set(exact, row); // a current key always beats a legacy row for the same slot
      continue;
    }
    const resolved = resolveStoredModelKey(row.key);
    if (resolved && !byKey.has(resolved)) byKey.set(resolved, row);
  }
  return MODEL_CATALOG.map((entry) => {
    const stored = byKey.get(entry.key);
    const health = providers?.[entry.providerId]?.health ?? null;
    const enabled = stored?.enabled ?? true; // no row ⇒ default ON
    return {
      key: entry.key,
      providerId: entry.providerId,
      modelRef: entry.modelRef,
      label: entry.label,
      description: entry.description,
      provider: liveDetail(health, "provider") ?? entry.provider,
      runtime: liveDetail(health, "runtime") ?? entry.runtime,
      enabled,
      dispatch: modelDispatchState(enabled, health),
      health,
      liveModel: liveModelFromHealth(health),
      note: stored?.note ?? null,
      updatedAt: stored?.updated_at ?? null,
      updatedBy: stored?.updated_by ?? null,
    };
  });
}

async function readControls(
  supa: SupabaseClient
): Promise<{ rows: ControlRow[]; error: string | null }> {
  try {
    const res = await supa.from("model_controls").select(CONTROL_COLUMNS);
    return { rows: (res.data ?? []) as ControlRow[], error: res.error?.message ?? null };
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** Catalog + stored switches + real health. Never throws — a failed health read degrades to null. */
/** A non-empty string field a live worker reported in its health detail, or null. */
function liveDetail(health: ProviderHealth | null, field: string): string | null {
  const v = health?.detail?.[field];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

export async function collectModelViews(supa: SupabaseClient): Promise<ModelView[]> {
  const [report, controls] = await Promise.all([
    buildHealthReport().catch(() => null),
    readControls(supa),
  ]);
  return mergeModelViews(controls.rows, report?.providers);
}

/** Validation result for a toggle request. Pure, so the HTTP rules are testable. */
export type ToggleValidation =
  | { ok: true; key: string; providerId: string; modelRef: string; enabled: boolean; note: string | null }
  | { ok: false; status: number; error: string; known?: string[] };

/**
 * Validate a PATCH /api/models/:key body. Unknown model → 404 with the known keys; a non-boolean
 * `enabled` → 400. `note` is trimmed and capped, and an empty note is stored as null.
 */
export function validateToggle(key: string | null | undefined, body: unknown): ToggleValidation {
  const entry = findModel(key);
  if (!entry) {
    return { ok: false, status: 404, error: `Unknown model "${key ?? ""}"`, known: MODEL_CATALOG.map((m) => m.key) };
  }
  const b = (body ?? {}) as { enabled?: unknown; note?: unknown };
  if (typeof b.enabled !== "boolean") {
    return { ok: false, status: 400, error: "enabled must be a boolean" };
  }
  const note = typeof b.note === "string" && b.note.trim() !== "" ? b.note.trim().slice(0, 500) : null;
  return { ok: true, key: entry.key, providerId: entry.providerId, modelRef: entry.modelRef, enabled: b.enabled, note };
}

/** GET /api/models */
export async function listModels(_req: Request, res: Response) {
  const supa = getServerSupabase();
  if (!supa) {
    return res.status(503).json({
      error: "Supabase not configured",
      reason: supabaseConfigReason() ?? "Supabase is not configured on the backend",
      hint: "Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY on Render and run supabase/migrations/004_model_controls.sql.",
      models: [],
    });
  }

  const models = await collectModelViews(supa);
  res.json({
    models,
    counts: {
      total: models.length,
      enabled: models.filter((m) => m.enabled).length,
      disabled: models.filter((m) => !m.enabled).length,
      ready: models.filter((m) => m.dispatch === "READY").length,
    },
    source: "supabase",
    timestamp: new Date().toISOString(),
  });
}

/** PATCH /api/models/:key — persist the on/off switch for one model. */
export async function setModelEnabled(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;

  const validated = validateToggle((req.params as { key?: string }).key, req.body);
  if (!validated.ok) {
    return res.status(validated.status).json({ error: validated.error, ...(validated.known ? { known: validated.known } : {}) });
  }

  const body = req.body as { updated_by?: unknown } | null;
  const actor =
    (typeof body?.updated_by === "string" && body.updated_by.trim()) ||
    (typeof req.headers["x-operator"] === "string" && req.headers["x-operator"]) ||
    "dashboard";

  const { error } = await supa.from("model_controls").upsert(
    {
      key: validated.key,
      provider_id: validated.providerId,
      model_ref: validated.modelRef,
      enabled: validated.enabled,
      note: validated.note,
      updated_by: actor,
    },
    { onConflict: "key" }
  );
  if (error) return res.status(400).json({ error: error.message });

  // Auditable: one event per decision (constraint 20), no secrets in the payload.
  await supa
    .from("events")
    .insert({
      type: validated.enabled ? "model.enabled" : "model.disabled",
      actor,
      payload: {
        key: validated.key,
        provider_id: validated.providerId,
        model_ref: validated.modelRef,
        enabled: validated.enabled,
        note: validated.note,
      },
    })
    .then(
      () => undefined,
      () => undefined
    );

  const models = await collectModelViews(supa);
  const model = models.find((m) => m.key === validated.key) ?? null;
  res.json({ model, changed: { key: validated.key, enabled: validated.enabled }, actor });
}
