// apps/api/src/lib/managerAutonomy.ts
// What the Management Team is allowed to DO on its own, and the single place that decides it.
//
// The management model may ASK for a runtime to be started. This module never trusts the model: it
// re-checks the operator's autonomy gate (`MANAGER_AUTONOMY`) and the REAL autostart path
// (`autostartRefusal`) for every target, and then calls the same supervisor the dashboard's Run Now
// button calls — so a start goes through the same lease/audit/history lifecycle as a human press.
//
// Truth rules (CONSTRAINTS.md):
//  - No simulated success. Every outcome is the supervisor's real answer (`requested`, `skipped_*`,
//    `not_autostartable`, or the error it returned).
//  - `MANAGER_AUTONOMY` defaults to `off`: an unconfigured or misspelled value never grants power.
//  - Only slots that really have an autostart path AND their own kernel ref configured can be started,
//    so this can never re-push the Script AI kernel as another agent.

import type { SupabaseClient } from "@supabase/supabase-js";
import { autostartRefusal, kaggleKernelRef, kaggleKernelRefEnvName, managerAutonomy, type ManagerAutonomy } from "@ostra/shared";
import { runNowByWorker } from "./scheduler.js";

/**
 * The real runtime/provider each startable slot lives on. Read from the catalog, never guessed. Every
 * Kaggle agent pushes its OWN notebook (Script via KAGGLE_KERNEL_REF, the others via
 * KAGGLE_KERNEL_REF_<SLOT>), so a start can never re-push the Script kernel as another agent.
 */
const SLOT_RUNTIMES: Record<string, { runtime: string; provider: string }> = {
  script: { runtime: "kaggle", provider: "kaggle" },
  image: { runtime: "kaggle", provider: "kaggle" },
  voice: { runtime: "kaggle", provider: "kaggle" },
  overseer: { runtime: "kaggle", provider: "kaggle" },
};

export type ManagerStartOutcome = {
  target: string;
  ok: boolean;
  action: string;
  error?: string;
  historyId?: string;
};

/**
 * Every slot the management team may ask to start, with the real reason each one cannot RIGHT NOW.
 * `ok` requires both a start path (catalog) and that slot's own kernel ref configured in the real
 * environment — configuration presence is read here, never assumed.
 */
export function startableTargets(): Array<{ target: string; ok: boolean; error?: string }> {
  return Object.keys(SLOT_RUNTIMES).map((target) => {
    const refusal = autostartRefusal(target);
    if (refusal) return { target, ok: false, error: refusal };
    const slot = SLOT_RUNTIMES[target];
    if (slot?.runtime === "kaggle" && !kaggleKernelRef(target)) {
      return {
        target,
        ok: false,
        error: `Set ${kaggleKernelRefEnvName(target)} on Render so ${target} can push its own Kaggle notebook`,
      };
    }
    return { target, ok: true };
  });
}

/**
 * Act on the `start` list the management model returned. Returns one honest outcome per requested
 * target, including the ones that were refused — a refusal is data, not an error to hide.
 */
export async function applyManagerStarts(
  supa: SupabaseClient,
  requested: readonly string[],
  opts: { autonomy?: ManagerAutonomy } = {}
): Promise<ManagerStartOutcome[]> {
  const autonomy = opts.autonomy ?? managerAutonomy();
  const seen = new Set<string>();
  const outcomes: ManagerStartOutcome[] = [];

  for (const raw of requested) {
    const target = raw.trim().toLowerCase();
    if (!target || seen.has(target)) continue;
    seen.add(target);

    if (autonomy !== "full") {
      outcomes.push({
        target,
        ok: false,
        action: "refused_autonomy",
        error:
          autonomy === "instruct"
            ? `MANAGER_AUTONOMY=${autonomy}: the management team may brief agents but not start runtimes. Set MANAGER_AUTONOMY=full on Render to allow it.`
            : "MANAGER_AUTONOMY=off: the management team may not start runtimes.",
      });
      continue;
    }

    const slot = SLOT_RUNTIMES[target];
    if (!slot) {
      outcomes.push({
        target,
        ok: false,
        action: "refused_unknown_target",
        error: `${target} is not a startable worker type`,
      });
      continue;
    }

    const refusal = autostartRefusal(target);
    if (refusal) {
      outcomes.push({ target, ok: false, action: "not_autostartable", error: refusal });
      continue;
    }

    try {
      const r = await runNowByWorker(supa, target, slot.runtime, slot.provider);
      outcomes.push({
        target,
        ok: r.action === "requested",
        action: r.action,
        ...(r.historyId ? { historyId: r.historyId } : {}),
        ...(r.error ? { error: r.error } : {}),
      });
    } catch (e) {
      outcomes.push({
        target,
        ok: false,
        action: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return outcomes;
}