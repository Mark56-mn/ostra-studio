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
import { kaggleConfig, kaggleApiTokens } from "../packages/shared/src/lib/env";
import { getKaggleAuthHeader, parseKernelRef } from "../packages/shared/src/providers/runtimeStarters";

const KAGGLE_API = "https://www.kaggle.com/api/v1";
/** Marker comment that identifies our managed bootstrap cell. */
const BOOTSTRAP_MARKER = "# ── Ostra Studio worker bootstrap (managed cell) ──";
const BOOTSTRAP_PATH = new URL("./kaggle-worker-bootstrap.py", import.meta.url).pathname;

/**
 * The notebook once shelled out to a Django dev server (`python manage.py runserver 8000`). There is
 * no manage.py in this notebook, port 8000 is already served by the FastAPI app started earlier, so
 * that command could only fail — and it sits *before* the tunnel and bootstrap cells. Retire it.
 */
const RETIRED_CELL_SOURCE = [
  "# ── retired cell (managed by scripts/kaggle-sync-notebook.ts) ──",
  "# This cell used to shell out to a Django dev server that does not exist in this notebook, on a",
  "# port already served by the FastAPI app started earlier. The dead command could only fail before",
  "# the tunnel and bootstrap cells ran, so it was retired.",
  'print("[ostra] retired the dead Django dev-server cell — FastAPI on :8000 is the real API")',
].join("\n");

const isRetiredCell = (source: string): boolean => source.includes("manage.py") && source.includes("runserver");

/**
 * Cells that must exist *before* the tunnel/bootstrap and must never abort the run.
 *
 * Verified against a real run log (2026-09-29, v9): cell 9 starts uvicorn in a background thread
 * and returns immediately, cell 10 then did `requests.get("http://127.0.0.1:8000/health")` before the
 * port was bound. That raised ConnectionRefusedError, papermill aborted the notebook at `In [10]`,
 * and cells 12-15 (pyngrok, the ngrok tunnel, the worker bootstrap) never executed — which is why
 * Script AI had never registered. Diagnostics must report, not abort.
 */
const MANAGED_PRE_TUNNEL_CELLS: Array<{ label: string; detect: (s: string) => boolean; content: string }> = [
  {
    label: "local API readiness check",
    detect: (s) => s.includes("127.0.0.1:8000/health") && s.includes("requests.get"),
    content: [
      "# ── Ostra Studio: local API readiness check (managed cell) ──",
      "# The FastAPI server above runs in a background thread and needs a moment before the port",
      "# accepts connections. Requesting it straight away used to raise ConnectionRefused and abort",
      "# the whole run, so the ngrok tunnel + worker bootstrap cells never ran. This waits for the",
      "# server, prints the real response, and never raises.",
      "import json",
      "import time",
      "",
      "import requests",
      "",
      'URL = "http://127.0.0.1:8000/health"',
      "DEADLINE = time.time() + 90",
      "ready = False",
      "response = None",
      "while time.time() < DEADLINE:",
      "    try:",
      "        response = requests.get(URL, timeout=5)",
      "        ready = True",
      "        break",
      "    except Exception as exc:",
      '        print(f"[ostra] {URL} not ready yet ({exc.__class__.__name__}) — retrying")',
      "        time.sleep(3)",
      "",
      "if ready:",
      '    print("Status:", response.status_code)',
      "    print(json.dumps(response.json(), indent=2))",
      "else:",
      '    print("[ostra] local API did not answer within 90s — continuing anyway (tunnel + bootstrap still run)")',
    ].join("\n"),
  },
  {
    label: "local chat smoke test",
    detect: (s) => s.includes("127.0.0.1:8000/v1/chat/completions"),
    content: [
      "# ── Ostra Studio: local chat smoke test (managed cell) ──",
      "# Diagnostic only — it must never abort the run, because the tunnel + worker bootstrap cells",
      "# come after it and papermill stops the notebook on the first uncaught exception.",
      "import json",
      "",
      "import requests",
      "",
      "payload = {",
      '    "model": MODEL_ID,',
      '    "messages": [{"role": "user", "content": "Give me a one sentence introduction to Ostra."}],',
      '    "temperature": 0.7,',
      '    "max_tokens": 150,',
      '    "stream": False,',
      "}",
      "",
      "try:",
      '    response = requests.post("http://127.0.0.1:8000/v1/chat/completions", json=payload, timeout=240)',
      '    print("HTTP:", response.status_code)',
      "    print(json.dumps(response.json(), indent=2))",
      "except Exception as exc:",
      '    print(f"[ostra] local chat test failed ({exc.__class__.__name__}: {exc}) — continuing anyway")',
    ].join("\n"),
  },
  {
    label: "ngrok tunnel",
    detect: (s) => s.includes("ngrok.connect("),
    content: [
      "# ── Ostra Studio: public tunnel via ngrok (managed cell) ──",
      "# Opens the public URL the Ostra backend will reach. If ngrok fails, this reports it and keeps",
      "# going with PUBLIC_URL = None instead of aborting the run before the worker bootstrap cell.",
      'from kaggle_secrets import UserSecretsClient',
      "from pyngrok import ngrok",
      "",
      'PUBLIC_URL = globals().get("PUBLIC_URL") or None',
      "",
      "try:",
      "    secrets = UserSecretsClient()",
      "    token = None",
      '    _labels = ("NGROK_AUTHTOKEN_SCRIPT", "NGROK_AUTHTOKEN", "ngrok_authtoken_script", "ngrok_authtoken")',
      "    _errors = []",
      "    for _name in _labels:",
      "        try:",
      "            token = secrets.get_secret(_name)",
      "        except Exception as _exc:",
      "            token = None",
      '            _errors.append(f"{_name} -> {_exc.__class__.__name__}: {str(_exc)[:100]}")',
      "        if token:",
      "            print(f\"[ostra] ngrok token read from Kaggle secret '{_name}'\")",
      "            break",
      "    if not token:",
      "        # 'wrong label' and 'secret not attached to this notebook' look the same from out here.",
      "        # Ask the service with a label that cannot exist and report its real answer. One short",
      "        # print per line: Kaggle's log API truncates long lines (~200 chars).",
      '        print("[ostra] ngrok secret lookup failed for this notebook")',
      "        for _e in _errors:",
      '            print(f"[ostra]   tried {_e}")',
      "        try:",
      '            secrets.get_secret("__ostra_secret_probe__")',
      '            print("[ostra]   probe __ostra_secret_probe__ unexpectedly resolved")',
      "        except Exception as _exc:",
      '            print(f"[ostra]   probe __ostra_secret_probe__ -> {_exc.__class__.__name__}: {str(_exc)[:100]}")',
      '        print("[ostra]   fix: secrets must be ATTACHED, not just created (Add-ons > Secrets, tick THIS notebook)")',
      '        raise RuntimeError("no ngrok token from Kaggle secrets (see the [ostra] lines above)")',
      "    ngrok.set_auth_token(token)",
      '    print("Ngrok authentication successful.")',
      "    tunnel = ngrok.connect(8000)",
      "    PUBLIC_URL = tunnel.public_url",
      '    print("Ostra PUBLIC API:")',
      "    print(PUBLIC_URL)",
      '    print("\\nHealth:")',
      '    print(PUBLIC_URL + "/health")',
      '    print("\\nChat:")',
      '    print(PUBLIC_URL + "/v1/chat/completions")',
      "except Exception as exc:",
      "    PUBLIC_URL = None",
      '    print(f"[ostra] ngrok tunnel FAILED ({exc.__class__.__name__}: {exc}) — no public URL")',
      '    print("[ostra] Script AI can still register, but it will have no reachable endpoint.")',
    ].join("\n"),
  },
  {
    label: "model load (VRAM-selecting)",
    detect: (s) => s.includes("AutoModelForCausalLM.from_pretrained") && s.includes("MODEL_ID ="),
    content: [
      "# ── Ostra Studio: model load (managed cell) ──",
      "# Picks the strongest model this GPU can actually serve: the OSTRA_MODEL (Kaggle secret)",
      "# overrides, otherwise free VRAM decides — 7-8B bf16 would OOM a free T4 before the tunnel +",
      "# registration ever run. The worker bootstrap reports THIS resolved model, so the registry",
      "# never claims a model that is not really running.",
      "import os",
      "",
      "import torch",
      "from transformers import AutoModelForCausalLM, AutoTokenizer",
      "",
      "try:",
      "    from kaggle_secrets import UserSecretsClient",
      "",
      "    _secrets = UserSecretsClient()",
      "",
      "    def _osecret(name):",
      "        try:",
      "            return _secrets.get_secret(name)",
      "        except Exception:",
      "            return os.environ.get(name)",
      "except Exception:",
      "    def _osecret(name):",
      "        return os.environ.get(name)",
      "",
      "_GPU_OK = torch.cuda.is_available()",
      "_VRAM_GIB = torch.cuda.get_device_properties(0).total_memory / (1024 ** 3) if _GPU_OK else 0.0",
      'MODEL_ID = _osecret("OSTRA_MODEL") or (',
      '    # 14.0 GiB gate: Kaggle T4 reports 14.6 GiB, and the measured 4B peak was 7.51 GiB (see',
      '    # bettertrade/ostra-model-benchmark), so 4B fits and is the quality default on a T4.',
      '    "Qwen/Qwen3-4B" if (_GPU_OK and _VRAM_GIB >= 14.0) else "Qwen/Qwen3-1.7B"',
      ")",
      'print(f"[ostra] model selected: {MODEL_ID} (gpu={_GPU_OK}, vram={_VRAM_GIB:.1f} GiB)")',
      "tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)",
      'model = AutoModelForCausalLM.from_pretrained(MODEL_ID, torch_dtype="auto", device_map="auto")',
    ].join("\n"),
  },
  {
    label: "chat server (OpenAI-compatible)",
    detect: (s) => s.includes('@app.post("/v1/chat/completions")'),
    content: [
      "# ── Ostra Studio: chat server (managed cell) ──",
      "# Serves OpenAI-compatible chat on :8000 — the SAME contract the Ostra backend calls",
      "# (POST /v1/chat/completions, GET /health). MODEL_ID comes from the model load cell above, and",
      "# every response names the model that is really running, never a hardcoded one.",
      "from typing import List, Optional",
      "",
      "import threading",
      "",
      "import torch",
      "import uvicorn",
      "from fastapi import FastAPI, HTTPException",
      "from pydantic import BaseModel",
      "",
      'app = FastAPI(title="Ostra AI", version="0.1.0")',
      "",
      "",
      "class Message(BaseModel):",
      "    role: str",
      "    content: str",
      "",
      "",
      "class ChatRequest(BaseModel):",
      "    model: Optional[str] = None",
      "    messages: List[Message]",
      "    temperature: Optional[float] = 0.7",
      "    max_tokens: Optional[int] = 512",
      "    stream: Optional[bool] = False",
      "",
      "",
      '@app.get("/")',
      "def root():",
      '    return {"name": "Ostra AI", "status": "online", "model": MODEL_ID}',
      "",
      "",
      '@app.get("/health")',
      "def health():",
      '    return {"status": "ok", "model": MODEL_ID}',
      "",
      "",
      '@app.post("/v1/chat/completions")',
      "def chat(request: ChatRequest):",
      "    if not request.messages:",
      '        raise HTTPException(status_code=400, detail="messages cannot be empty")',
      "",
      '    messages = [{"role": m.role, "content": m.content} for m in request.messages]',
      "    inputs = tokenizer.apply_chat_template(",
      "        messages,",
      "        add_generation_prompt=True,",
      "        tokenize=True,",
      "        return_dict=True,",
      '        return_tensors="pt",',
      "    )",
      "    inputs = inputs.to(model.device)",
      "",
      "    max_tokens = min(request.max_tokens or 512, 1024)",
      "    temperature = max(float(request.temperature or 0.7), 0.01)",
      "",
      "    with torch.no_grad():",
      "        outputs = model.generate(",
      "            **inputs,",
      "            max_new_tokens=max_tokens,",
      "            do_sample=temperature > 0,",
      "            temperature=temperature,",
      "        )",
      "",
      '    generated_tokens = outputs[0, inputs["input_ids"].shape[-1]:]',
      "    response_text = tokenizer.decode(generated_tokens, skip_special_tokens=True)",
      "",
      "    return {",
      '        "id": "ostra-response",',
      '        "object": "chat.completion",',
      '        "model": MODEL_ID,',
      '        "choices": [',
      "            {",
      '                "index": 0,',
      '                "message": {"role": "assistant", "content": response_text},',
      '                "finish_reason": "stop",',
      "            }",
      "        ],",
      "    }",
      "",
      "",
      "def run_server():",
      '    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")',
      "",
      "",
      "server_thread = threading.Thread(target=run_server, daemon=True)",
      "server_thread.start()",
      "",
      'print("======================================")',
      'print("OSTRA API STARTED")',
      'print("======================================")',
      'print("Local address: http://127.0.0.1:8000")',
    ].join("\n"),
  },
];

function codeCell(source: string) {
  return {
    cell_type: "code",
    execution_count: null,
    metadata: {},
    outputs: [],
    source: source.split("\n").map((line, i, all) => (i === all.length - 1 ? line : `${line}\n`)),
  };
}

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
  console.log(`  ${presence("KAGGLE_API_TOKEN_1", process.env.KAGGLE_API_TOKEN_1)}`);
  console.log(`  ${presence("KAGGLE_API_TOKEN_2", process.env.KAGGLE_API_TOKEN_2)}`);
  console.log(`  ${presence("KAGGLE_KERNEL_REF", process.env.KAGGLE_KERNEL_REF)}`);

  const kernelRefArg = process.argv.find((a) => a.startsWith("--kernel-ref="));
  const kernelRef = cfg.kernelRef ?? kernelRefArg?.slice("--kernel-ref=".length).trim();
  const apiToken = cfg.apiToken ?? kaggleApiTokens()[0];
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

  // ── 2. Reconcile every managed cell ────────────────────────────────────────
  const bootstrap = readFileSync(BOOTSTRAP_PATH, "utf8");
  const existingIndex = cells.findIndex((c) => cellSource(c).includes(BOOTSTRAP_MARKER));
  const bootstrapInSync = existingIndex >= 0 && cellSource(cells[existingIndex]!) === bootstrap;
  const retiredIndexes = cells.map((c, i) => [i, cellSource(c)] as const).filter(([, s]) => isRetiredCell(s)).map(([i]) => i);

  const nextCells = [...cells];
  const changes: string[] = [];

  console.log("\n--- 2) Managed cell reconciliation ---");
  console.log(`  bootstrap cell: ${existingIndex >= 0 ? `present at index ${existingIndex}` : "MISSING"} — in sync: ${bootstrapInSync ? "yes" : "NO"}`);

  for (const rule of MANAGED_PRE_TUNNEL_CELLS) {
    const idx = cells.findIndex((c) => rule.detect(cellSource(c)));
    if (idx < 0) {
      console.log(`  ${rule.label}: not present in this notebook — skipping`);
      continue;
    }
    if (cellSource(cells[idx]!) === rule.content) {
      console.log(`  ${rule.label}: in sync (cell ${idx})`);
      continue;
    }
    nextCells[idx] = codeCell(rule.content);
    changes.push(`${rule.label} (cell ${idx})`);
  }

  for (const i of retiredIndexes) {
    nextCells[i] = codeCell(RETIRED_CELL_SOURCE);
    changes.push(`retired dead Django cell (cell ${i})`);
  }
  if (!bootstrapInSync) changes.push(`bootstrap cell (index ${existingIndex >= 0 ? existingIndex : "appended"})`);

  if (changes.length === 0) {
    console.log("\n  RESULT: ALREADY IN SYNC — no push needed.");
    return 0;
  }
  console.log(`\n  changes to push: ${changes.join("; ")}`);

  if (existingIndex >= 0) nextCells[existingIndex] = codeCell(bootstrap);
  else nextCells.push(codeCell(bootstrap));

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
