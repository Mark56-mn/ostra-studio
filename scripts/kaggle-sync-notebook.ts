#!/usr/bin/env bun
/**
 * Sync the Ostra worker bootstrap into the live Kaggle notebook.
 *
 * The Script AI worker can only reach ONLINE if the notebook actually registers itself
 * (POST /api/workers/register) and then heartbeats. That code lives in the notebook, so this
 * script keeps the notebook's bootstrap cell in sync with the canonical copy committed in
 * scripts/kaggle-worker-bootstrap.py.
 *
 * Nothing here is mocked: it reads the REAL kernel source from the Kaggle API and (with --apply)
 * pushes a REAL new version. Secrets are never printed.
 *
 * Usage (repo root):
 *   bun scripts/kaggle-sync-notebook.ts --dump    # print the live notebook's cell structure (read-only)
 *   bun scripts/kaggle-sync-notebook.ts           # dry run: show whether the bootstrap is in sync
 *   bun scripts/kaggle-sync-notebook.ts --apply   # push a new kernel version with the bootstrap applied
 *
 * Exit codes: 0 ok/in-sync | 2 NOT_CONFIGURED | 3 AUTH_FAILED/unreachable | 1 other failure
 */

import { readFileSync } from "node:fs";
import { kaggleConfig } from "../packages/shared/src/lib/env";
import { getKaggleAuthHeader, parseKernelRef } from "../packages/shared/src/providers/runtimeStarters";

const KAGGLE_API = "https://www.kaggle.com/api/v1";
/** Marker comment that identifies our managed bootstrap cell. */
const BOOTSTRAP_MARKER = "# ── Ostra Studio worker bootstrap (managed cell) ──";
const BOOTSTRAP_PATH = new URL("./kaggle-worker-bootstrap.py", import.meta.url).pathname;

const mode = process.argv.includes("--apply") ? "apply" : process.argv.includes("--dump") ? "dump" : "dry-run";

function presence(name: string, raw: string | undefined): string {
  if (raw === undefined) return `${name}=MISSING`;
  if (!raw.trim()) return `${name}=present but BLANK`;
  return `${name}=set (${raw.trim().length} chars)`;
}

type Notebook = { cells?: Array<{ cell_type?: string; source?: string[] | string }> } & Record<string, unknown>;

function cellSource(cell: { source?: string[] | string }): string {
  const s = cell.source;
  if (Array.isArray(s)) return s.join("");
  return typeof s === "string" ? s : "";
}

async function main(): Promise<number> {
  console.log("=== Ostra Studio: Kaggle notebook bootstrap sync ===");
  console.log(`at ${new Date().toISOString()}  mode=${mode}\n`);

  const cfg = kaggleConfig();
  console.log("--- Configuration (values never printed) ---");
  console.log(`  ${presence("KAGGLE_API_TOKEN", process.env.KAGGLE_API_TOKEN)}`);
  console.log(`  ${presence("KAGGLE_KERNEL_REF", process.env.KAGGLE_KERNEL_REF)}`);

  const kernelRefArg = process.argv.find((a) => a.startsWith("--kernel-ref="));
  const kernelRef = cfg.kernelRef ?? kernelRefArg?.slice("--kernel-ref=".length).trim();
  const apiToken = cfg.apiToken ?? process.env.KAGGLE_API_TOKEN?.trim();
  if (!apiToken || !kernelRef) {
    console.log(`\n  RESULT: NOT_CONFIGURED — needs a token and KAGGLE_KERNEL_REF (or --kernel-ref=owner/slug).`);
    return 2;
  }
  if (!cfg.kernelRef) console.log(`  PROBE ONLY: using --kernel-ref=${kernelRef}; KAGGLE_KERNEL_REF is still unset.`);

  const authHeader = getKaggleAuthHeader(apiToken);
  const { owner, slug } = parseKernelRef(kernelRef);
  if (!owner) {
    console.log("  RESULT: ERROR — the kernel ref must be owner/slug to sync a notebook.");
    return 1;
  }

  // ── 1. Read the real kernel ────────────────────────────────────────────────
  const pullUrl = `${KAGGLE_API}/kernels/pull?user_name=${encodeURIComponent(owner)}&kernel_slug=${encodeURIComponent(slug)}`;
  let res: Response;
  try {
    res = await fetch(pullUrl, { headers: { Authorization: authHeader }, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    console.log(`  GET ${pullUrl} -> unreachable: ${e instanceof Error ? e.message : String(e)}`);
    return 3;
  }
  console.log(`\n--- 1) Real kernel read ---\n  GET ${pullUrl} -> HTTP ${res.status}`);
  if (res.status === 401 || res.status === 403) {
    console.log("  RESULT: AUTH_FAILED — the token was rejected by Kaggle.");
    return 3;
  }
  if (!res.ok) {
    console.log(`  body: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    console.log(`  RESULT: ERROR — Kaggle returned HTTP ${res.status}.`);
    return 1;
  }

  const data = (await res.json()) as { blob?: Record<string, unknown>; metadata?: Record<string, unknown> };
  const source = typeof data.blob?.source === "string" ? data.blob.source : "";
  const meta = data.metadata ?? {};
  const blob = data.blob ?? {};
  const versionNumber = Number(meta.currentVersionNumber);
  const title = typeof meta.title === "string" ? meta.title : slug;
  if (!source) {
    console.log("  RESULT: ERROR — Kaggle returned no notebook source.");
    return 1;
  }
  console.log(`  title=${title} language=${String(blob.language)} kernelType=${String(blob.kernelType)}`);
  console.log(`  currentVersionNumber=${meta.currentVersionNumber} source=${source.length} chars`);

  let nb: Notebook;
  try {
    nb = JSON.parse(source) as Notebook;
  } catch (e) {
    console.log(`  RESULT: ERROR — the kernel source is not a JSON notebook: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const cells = nb.cells ?? [];
  console.log(`  nbformat=${String((nb as Record<string, unknown>).nbformat)} cells=${cells.length}`);

  cells.forEach((c, i) => {
    const s = cellSource(c);
    const firstLine = s.split("\n").find((l) => l.trim())?.slice(0, 90) ?? "";
    const managed = s.includes(BOOTSTRAP_MARKER) ? "  <-- managed bootstrap" : "";
    console.log(`    [${String(i).padStart(2)}] ${String(c.cell_type).padEnd(8)} ${String(s.length).padStart(5)} chars  ${firstLine}${managed}`);
  });

  if (mode === "dump") {
    if (process.argv.includes("--dump-full")) {
      const from = Number(process.argv.find((a) => a.startsWith("--from="))?.slice("--from=".length) ?? 0) || 0;
      console.log("\n--- full cell sources ---");
      cells.forEach((c, i) => {
        if (i < from) return;
        console.log(`\n===== cell ${i} [${String(c.cell_type)}] =====`);
        console.log(cellSource(c));
      });
    }
    console.log("\n  RESULT: (dump only) no writes were performed.");
    return 0;
  }

  // ── 2. Reconcile the managed bootstrap cell ────────────────────────────────
  const bootstrap = readFileSync(BOOTSTRAP_PATH, "utf8");
  const existingIndex = cells.findIndex((c) => cellSource(c).includes(BOOTSTRAP_MARKER));
  const current = existingIndex >= 0 ? cellSource(cells[existingIndex]!) : null;
  const inSync = current === bootstrap;

  console.log("\n--- 2) Bootstrap reconciliation ---");
  console.log(`  managed cell: ${existingIndex >= 0 ? `present at index ${existingIndex}` : "MISSING"}`);
  console.log(`  in sync with scripts/kaggle-worker-bootstrap.py: ${inSync ? "yes" : "NO"}`);

  if (inSync) {
    console.log("\n  RESULT: ALREADY IN SYNC — no push needed.");
    return 0;
  }

  const nextCells = [...cells];
  const bootstrapCell = {
    cell_type: "code",
    execution_count: null,
    metadata: {},
    outputs: [],
    source: bootstrap.split("\n").map((line, i, all) => (i === all.length - 1 ? line : `${line}\n`)),
  };
  if (existingIndex >= 0) nextCells[existingIndex] = bootstrapCell;
  else nextCells.push(bootstrapCell);

  const nextSource = JSON.stringify({ ...nb, cells: nextCells });
  console.log(`  next source: ${nextSource.length} chars (${nextSource.length - source.length >= 0 ? "+" : ""}${nextSource.length - source.length})`);

  if (mode !== "apply") {
    console.log("\n  RESULT: DRY RUN — re-run with --apply to push a REAL new kernel version.");
    return 0;
  }

  // ── 3. Real push ──────────────────────────────────────────────────────────
  console.log("\n--- 3) Real push of the updated notebook ---");
  const pushBody = {
    slug: `${owner}/${slug}`,
    newTitle: title,
    text: nextSource,
    language: typeof blob.language === "string" ? blob.language : "python",
    kernelType: typeof blob.kernelType === "string" ? blob.kernelType : "notebook",
    isPrivate: meta.isPrivate === true,
    enableInternet: meta.enableInternet !== false,
    enableGpu: meta.enableGpu !== false,
    enableTpu: meta.enableTpu === true,
  };
  let pushRes: Response;
  try {
    pushRes = await fetch(`${KAGGLE_API}/kernels/push`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify(pushBody),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    console.log(`  push -> unreachable: ${e instanceof Error ? e.message : String(e)}`);
    return 3;
  }
  const raw = await pushRes.text().catch(() => "");
  console.log(`  POST ${KAGGLE_API}/kernels/push -> HTTP ${pushRes.status}`);
  if (!pushRes.ok) {
    console.log(`  body: ${raw.slice(0, 300)}`);
    console.log("  RESULT: PUSH FAILED — the notebook was not changed.");
    return pushRes.status === 401 || pushRes.status === 403 ? 3 : 1;
  }
  let parsed: Record<string, unknown> = {};
  try { parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}; } catch { parsed = { raw: raw.slice(0, 300) }; }
  console.log(`  versionNumber=${String(parsed.versionNumber)} previousVersion=${String(versionNumber)}`);
  console.log(`  url=${String(parsed.url ?? "(none)")}`);
  console.log("\n  RESULT: PUSHED — the notebook now carries the register + heartbeat bootstrap.");
  console.log("  A run is requested, not online: ONLINE requires the notebook to boot, register and keep heartbeating.");
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => { console.error("unexpected failure:", e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
