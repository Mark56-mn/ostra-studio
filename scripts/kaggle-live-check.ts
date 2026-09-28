#!/usr/bin/env bun
/**
 * REAL Kaggle connectivity check for the Ostra Script AI runtime (bettertrade/notebook7eae283a4a).
 *
 * There is no mock mode here. Every result printed below comes from either an actual environment
 * read or an actual HTTP call to https://www.kaggle.com/api/v1. Nothing is fabricated and secret
 * values are never printed. The auth header is built by the SAME function the runtime uses.
 *
 * Usage (from the repo root):
 *   bun scripts/kaggle-live-check.ts          # config + auth + kernel metadata (read-only)
 *   bun scripts/kaggle-live-check.ts --push   # also push a REAL new kernel version (starts a run)
 *   bun scripts/kaggle-live-check.ts --logs   # read the last run's output and print the [ostra] bootstrap lines
 *
 * --kernel-ref=<owner/slug> probes a specific kernel without adding it to the environment. The
 * env-read status is still reported honestly, so a probe ref never masks a missing production key.
 *
 * Exit codes: 0 verified | 2 NOT_CONFIGURED | 3 AUTH_FAILED/unreachable | 1 other failure
 */

import { kaggleConfig } from "../packages/shared/src/lib/env";
import {
  getKaggleAuthHeader,
  parseKernelRef,
  KaggleRuntimeStarter,
} from "../packages/shared/src/providers/runtimeStarters";

const KAGGLE_API = "https://www.kaggle.com/api/v1";
const push = process.argv.includes("--push");
const logs = process.argv.includes("--logs");

function presence(name: string, raw: string | undefined): string {
  if (raw === undefined) return `${name}=MISSING`;
  if (!raw.trim()) return `${name}=present but BLANK`;
  return `${name}=set (${raw.trim().length} chars)`;
}

async function main(): Promise<number> {
  console.log("=== Ostra Studio: REAL Kaggle path check ===");
  console.log(`at ${new Date().toISOString()}  mode=${push ? "push (starts a real run)" : "read-only"}\n`);

  // ── 1. Configuration ───────────────────────────────────────────────────────
  console.log("--- 1) Configuration (values never printed) ---");
  const cfg = kaggleConfig();
  const probeRefArg = process.argv.find((a) => a.startsWith("--kernel-ref="));
  const probeRef = probeRefArg ? probeRefArg.slice("--kernel-ref=".length).trim() : undefined;
  console.log(`  ${presence("KAGGLE_API_TOKEN", process.env.KAGGLE_API_TOKEN)}`);
  console.log(`  ${presence("KAGGLE_KERNEL_REF", process.env.KAGGLE_KERNEL_REF)}`);
  console.log(`  KAGGLE_EXEC_DISABLED=${process.env.KAGGLE_EXEC_DISABLED ?? "(unset)"}`);

  const envConfigured = cfg.configured;
  if (!envConfigured) {
    console.log(`\n  ENV RESULT: NOT_CONFIGURED — ${cfg.reason}`);
    console.log("  The deployed Script provider stays NOT_CONFIGURED until BOTH keys exist.");
  } else {
    console.log("  env configured: yes (token + kernel ref present)");
  }

  const kernelRefRaw = cfg.kernelRef ?? probeRef;
  const apiToken = cfg.apiToken ?? process.env.KAGGLE_API_TOKEN?.trim();
  if (!apiToken || !kernelRefRaw) {
    console.log("  No probe possible (needs a token AND --kernel-ref). No Kaggle request was attempted.");
    return 2;
  }
  if (!cfg.kernelRef) {
    console.log(`  PROBE ONLY: using --kernel-ref=${kernelRefRaw}; KAGGLE_KERNEL_REF is still unset in the environment.`);
  }

  const authHeader = getKaggleAuthHeader(apiToken);
  const { owner, slug } = parseKernelRef(kernelRefRaw);
  console.log(`  kernel ref parsed: owner=${owner ?? "(unresolved)"} slug=${slug}`);

  // ── 2. Real authentication probe ───────────────────────────────────────────
  console.log("\n--- 2) Real authenticated call to Kaggle ---");
  const listUrl = `${KAGGLE_API}/kernels/list?pageSize=1`;
  let listRes: Response;
  try {
    listRes = await fetch(listUrl, { headers: { Authorization: authHeader }, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    console.log(`  GET ${listUrl} -> unreachable: ${e instanceof Error ? e.message : String(e)}`);
    console.log("\n  RESULT: UNREACHABLE — Kaggle could not be contacted. No run was started.");
    return 3;
  }
  console.log(`  GET ${listUrl} -> HTTP ${listRes.status}`);
  if (listRes.status === 401 || listRes.status === 403) {
    console.log(`  body: ${(await listRes.text().catch(() => "")).slice(0, 300)}`);
    console.log("\n  RESULT: AUTH_FAILED — KAGGLE_API_TOKEN was rejected by Kaggle.");
    console.log("  Fix the token on Render, then re-run. No run was started.");
    return 3;
  }
  if (!listRes.ok) {
    console.log(`  body: ${(await listRes.text().catch(() => "")).slice(0, 300)}`);
    console.log(`\n  RESULT: ERROR — Kaggle returned HTTP ${listRes.status}. No run was started.`);
    return 1;
  }
  console.log("  auth: OK — the token is accepted by the Kaggle API");

  // ── 3. Real kernel metadata read ───────────────────────────────────────────
  if (owner) {
    console.log("\n--- 3) Real kernel metadata read ---");
    const kernelUrl = `${KAGGLE_API}/kernels/pull?user_name=${encodeURIComponent(owner)}&kernel_slug=${encodeURIComponent(slug)}`;
    let kernelRes: Response;
    try {
      kernelRes = await fetch(kernelUrl, { headers: { Authorization: authHeader }, signal: AbortSignal.timeout(15000) });
    } catch (e) {
      console.log(`  GET ${kernelUrl} -> unreachable: ${e instanceof Error ? e.message : String(e)}`);
      return 3;
    }
    console.log(`  GET ${kernelUrl} -> HTTP ${kernelRes.status}`);
    if (!kernelRes.ok) {
      console.log(`  body: ${(await kernelRes.text().catch(() => "")).slice(0, 300)}`);
      console.log("\n  RESULT: ERROR — the kernel ref in KAGGLE_KERNEL_REF is not readable with this token.");
      return 1;
    }
    const data = (await kernelRes.json().catch(() => null)) as Record<string, unknown> | null;
    const blob = (data?.blob as Record<string, unknown> | undefined) ?? {};
    const meta = (data?.metadata as Record<string, unknown> | undefined) ?? {};
    const source = typeof blob.source === "string" ? blob.source : "";
    const nextVersion = Number(meta.currentVersionNumber) + 1;
    console.log(`  title=${String(meta.title ?? "(unknown)")}`);
    console.log(`  language=${String(blob.language ?? "(unknown)")} kernelType=${String(blob.kernelType ?? "(unknown)")}`);
    console.log(`  source available=${source.length > 0} (${source.length} chars) — required to push a new version`);
    console.log(`  currentVersionNumber=${String(meta.currentVersionNumber ?? "(not reported)")}`);
    console.log(`  enableInternet=${String(meta.enableInternet)} enableGpu=${String(meta.enableGpu)} isPrivate=${String(meta.isPrivate)}`);
    console.log(`  next push would produce provider_run_id=${owner}/${slug}@v${Number.isFinite(nextVersion) ? nextVersion : "<next>"}`);
    if (source.length === 0) {
      console.log("\n  RESULT: ERROR — Kaggle returned no notebook source, so a push cannot start a run.");
      return 1;
    }
  } else {
    console.log("\n--- 3) Kernel ref has no owner; the runtime resolves it via the Kaggle API at start time ---");
  }

  // ── 3b. Optional: read the last run's log (why a worker did or did not register) ──
  if (logs && owner) {
    console.log("\n--- 3b) Last run output (bootstrap log) ---");
    const listingUrl = `${KAGGLE_API}/kernels/list?group=profile&pageSize=100&search=${encodeURIComponent(slug)}`;
    try {
      const lr = await fetch(listingUrl, { headers: { Authorization: authHeader }, signal: AbortSignal.timeout(20000) });
      if (lr.ok) {
        const lj = (await lr.json().catch(() => null)) as Record<string, unknown> | null;
        const items: Array<Record<string, unknown>> = Array.isArray(lj) ? (lj as Array<Record<string, unknown>>) : ((lj?.kernels as Array<Record<string, unknown>>) ?? []);
        const match = items.find((k) => (k.slug as string) === slug || (k.ref as string) === `${owner}/${slug}`);
        if (match) console.log(`  lastRunTime=${String(match.lastRunTime ?? "(not reported)")} totalVotes=${String(match.totalVotes ?? "(n/a)")}`);
      }
    } catch { /* listing is best-effort */ }

    const outUrl = `${KAGGLE_API}/kernels/output?user_name=${encodeURIComponent(owner)}&kernel_slug=${encodeURIComponent(slug)}`;
    const outRes = await fetch(outUrl, { headers: { Authorization: authHeader }, signal: AbortSignal.timeout(25000) }).catch(() => null);
    if (!outRes) {
      console.log(`  GET ${outUrl} -> unreachable`);
    } else {
      console.log(`  GET ${outUrl} -> HTTP ${outRes.status}`);
      if (outRes.ok) {
        const oj = (await outRes.json().catch(() => null)) as { files?: Array<{ name?: string; size?: number; url?: string }> } | null;
        const files = oj?.files ?? [];
        console.log(`  output files: ${files.length}`);
        for (const f of files.slice(0, 20)) console.log(`    - ${String(f.name)} (${String(f.size ?? "?")} bytes)`);
        for (const f of files) {
          if (!f.url || !/\.(ipynb|json|txt|log)$/.test(String(f.name))) continue;
          const txt = await fetch(f.url, { signal: AbortSignal.timeout(25000) }).then((r) => r.text()).catch(() => "");
          const lines = txt.split("\n").filter((l) => l.includes("[ostra]")).slice(0, 40);
          if (lines.length) {
            console.log(`\n  [ostra] bootstrap lines from ${String(f.name)}:`);
            for (const l of lines) console.log(`    ${l.replace(/\\n/g, " ").trim().slice(0, 220)}`);
          }
        }
      }
    }
    console.log("  NOTE: no output yet means the run has not finished (or has not started).");
  }

  // ── 4. Optional real push ──────────────────────────────────────────────────
  if (!push) {
    console.log("\n  RESULT: KAGGLE CONFIGURED AND AUTHENTICATED (read-only). No run was started.");
    console.log("  Re-run with --push to start a REAL kernel version.");
    console.log("  NOTE: ONLINE still requires the notebook to call POST /api/workers/register + heartbeat.");
    return 0;
  }

  console.log("\n--- 4) Real push via the production starter ---");
  const starter = new KaggleRuntimeStarter({ apiToken: cfg.apiToken, kernelRef: kernelRefRaw });
  const outcome = await starter.start({
    worker_type: "script",
    runtime: "kaggle",
    provider: "kaggle",
    trigger_source: "kaggle-live-check",
  });

  if (!outcome.ok) {
    console.log(`  push FAILED code=${outcome.code ?? "UNKNOWN"}`);
    console.log(`  error: ${outcome.error}`);
    console.log(`  provider_response: ${JSON.stringify(outcome.provider_response ?? {})}`);
    return outcome.code === "AUTH_FAILED" ? 3 : 1;
  }

  console.log(`  startup_request_id=${outcome.startup_request_id}`);
  console.log(`  provider_run_id=${outcome.provider_run_id}`);
  console.log(`  initial_state=${outcome.initial_state} (must NOT be ONLINE)`);
  console.log(`  provider_response=${JSON.stringify(outcome.provider_response)}`);
  console.log("\n  RESULT: PUSH ACCEPTED. The Kaggle run is requested, not online.");
  console.log("  Verify: GET https://ostra-studio-1.onrender.com/api/runtime/history?worker_type=script&runtime=kaggle");
  console.log("  ONLINE only after the notebook registers + heartbeats.");
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error("unexpected failure:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
