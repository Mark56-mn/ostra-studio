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

import { kaggleConfig, kaggleApiTokens } from "../packages/shared/src/lib/env";
import {
  getKaggleAuthHeader,
  parseKernelRef,
  KaggleRuntimeStarter,
} from "../packages/shared/src/providers/runtimeStarters";

const KAGGLE_API = "https://www.kaggle.com/api/v1";
const push = process.argv.includes("--push");
const logs = process.argv.includes("--logs");
/** Print the whole run log instead of only the lines that look interesting (early failures are noisy). */
const rawLog = process.argv.includes("--raw");

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
  console.log(`  ${presence("KAGGLE_API_TOKEN_1", process.env.KAGGLE_API_TOKEN_1)}`);
  console.log(`  ${presence("KAGGLE_API_TOKEN_2", process.env.KAGGLE_API_TOKEN_2)}`);
  console.log(`  ${presence("KAGGLE_KERNEL_REF", process.env.KAGGLE_KERNEL_REF)}`);
  console.log(`  KAGGLE_EXEC_DISABLED=${process.env.KAGGLE_EXEC_DISABLED ?? "(unset)"}`);

  const envConfigured = cfg.configured;
  if (!envConfigured) {
    console.log(`\n  ENV RESULT: NOT_CONFIGURED — ${cfg.reason}`);
    console.log("  The deployed Script provider stays NOT_CONFIGURED until BOTH keys exist.");
  } else {
    console.log("  env configured: yes (token + kernel ref present)");
  }

  // An explicit --kernel-ref= must WIN over the environment: it exists to probe another kernel
  // (e.g. an agent notebook) without changing KAGGLE_KERNEL_REF. Previously the env silently took
  // precedence, so --kernel-ref= was ignored whenever KAGGLE_KERNEL_REF was set.
  const kernelRefRaw = probeRef ?? cfg.kernelRef;
  // --token=<n> probes with a specific numbered token (1-based, as listed in the presence lines) —
  // needed to read PRIVATE kernels that belong to the second account, not the first token's.
  const tokenArg = process.argv.find((a) => a.startsWith("--token="))?.slice("--token=".length).trim();
  const allTokens = kaggleApiTokens();
  let apiToken = cfg.apiToken ?? allTokens[0];
  if (tokenArg) {
    const n = Number.parseInt(tokenArg, 10);
    if (!Number.isInteger(n) || n < 1 || n > allTokens.length) {
      console.log(`  --token=${tokenArg} is out of range: ${allTokens.length} token(s) configured.`);
      return 2;
    }
    apiToken = allTokens[n - 1];
  }
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
        const oj = (await outRes.json().catch(() => null)) as {
          files?: Array<{ name?: string; size?: number; url?: string }>;
          logNullable?: string;
          log?: unknown;
        } | null;
        const files = oj?.files ?? [];
        console.log(`  output files: ${files.length}`);
        for (const f of files.slice(0, 20)) console.log(`    - ${String(f.name)} (${String(f.size ?? "?")} bytes)`);
        for (const f of files) {
          if (!f.url || !/\.(ipynb|json|txt|log)$/.test(String(f.name))) continue;
          const txt = await fetch(f.url, { signal: AbortSignal.timeout(25000) }).then((r) => r.text()).catch(() => "");
          const ostraLines = txt.split("\n").filter((l) => l.includes("[ostra]")).slice(0, 40);
          if (ostraLines.length) {
            console.log(`\n  [ostra] bootstrap lines from ${String(f.name)}:`);
            for (const l of ostraLines) console.log(`    ${l.replace(/\\n/g, " ").trim().slice(0, 220)}`);
          }
        }

        // The run's own stdout/stderr comes back inline as a JSON string. This is the only reliable
        // way to see WHY a version did or did not reach the bootstrap cell: a run that aborts early
        // writes no output files at all, so "0 output files" alone hides the real reason.
        const rawLog = typeof oj?.logNullable === "string" ? oj.logNullable : typeof oj?.log === "string" ? oj.log : null;
        let entries: Array<{ data?: string; stream_name?: string }> = [];
        if (rawLog) {
          try {
            entries = JSON.parse(rawLog) as Array<{ data?: string; stream_name?: string }>;
          } catch {
            entries = [];
          }
        }
        console.log(`\n  run log entries: ${entries.length} (real stdout/stderr of the last run)`);
        if (entries.length && rawLog) {
          console.log("  ---- raw log (--raw) ----");
          for (const e of entries.slice(0, 300)) {
            for (const line of String(e.data ?? "").split("\n")) {
              if (line.trim()) console.log(`    ${line.slice(0, 240)}`);
            }
          }
          console.log("  ---- end raw log ----");
        } else if (entries.length) {
          const seen = new Set<string>();
          const interesting: string[] = [];
          for (const e of entries) {
            const line = String(e.data ?? "").replace(/\s+/g, " ").trim();
            if (!line) continue;
            if (!/\[ostra\]|PapermillExecutionError|Exception encountered at|Connection refused|Address already in use|ModuleNotFoundError|ngrok tunnel FAILED|OSTRA API STARTED|Uvicorn running|did not answer within/.test(line)) continue;
            if (seen.has(line)) continue;
            seen.add(line);
            interesting.push(line);
            if (interesting.length >= 60) break;
          }
          for (const line of interesting) console.log(`    ${line.slice(0, 220)}`);
          const abortAt = entries.map((e) => String(e.data ?? "")).find((d) => d.includes("Exception encountered at"));
          if (abortAt) console.log(`  ABORT POINT: ${abortAt.replace(/\s+/g, " ").trim()}`);
        }
      }
    }
    console.log("  NOTE: an empty run log means the run has not produced output yet (queued or still running).");
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
