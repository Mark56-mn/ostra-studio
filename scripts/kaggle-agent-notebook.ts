#!/usr/bin/env bun
/**
 * Create or refresh a Kaggle notebook for a non-script agent (Image AI / Voice AI / Showrunner).
 *
 * The Script AI notebook already exists and is operator-managed. This script composes a NEW notebook
 * for one agent role out of cells that are all in this repo:
 *
 *   1. install cell        — fastapi/uvicorn/transformers/accelerate/pyngrok
 *   2. model server cell   — a FastAPI OpenAI-compatible chat server on :8000 (the SAME contract the
 *                            Ostra backend calls: POST /v1/chat/completions, GET /health)
 *   3. readiness cell      — waits for the local server; never aborts the run
 *   4. tunnel cell         — ngrok, publishing PUBLIC_URL
 *   5. bootstrap cell      — scripts/kaggle-agent-bootstrap.py with THIS agent's identity substituted
 *
 * Nothing is mocked: the notebook really boots a model, really tunnels, and really registers. If the
 * model fails to load, the server is not up, the tunnel check records the real failure, and the agent
 * does not come ONLINE — that is the honest outcome, not a fabricated one.
 *
 * Usage (repo root):
 *   bun scripts/kaggle-agent-notebook.ts --agent=image --dump      # build + print the cell plan (no writes)
 *   bun scripts/kaggle-agent-notebook.ts --agent=image             # dry run: show what would be pushed
 *   bun scripts/kaggle-agent-notebook.ts --agent=image --apply     # create/update the real kernel
 *   bun scripts/kaggle-agent-notebook.ts --agent=image --voice --apply   # several at once
 *
 * Exit codes: 0 ok | 2 NOT_CONFIGURED | 3 AUTH_FAILED/unreachable | 1 other failure
 */

import { readFileSync } from "node:fs";
import { AGENT_ROSTER, kaggleConfig, getKaggleAuthHeader, parseKernelRef } from "../packages/shared/src/index";

const KAGGLE_API = "https://www.kaggle.com/api/v1";
const BOOTSTRAP_PATH = new URL("./kaggle-agent-bootstrap.py", import.meta.url).pathname;
const DEFAULT_OWNER = "bettertrade";

/** The roles this script can build. Script AI keeps its own operator-managed notebook. */
export const AGENT_NOTEBOOK_KINDS = ["image", "voice", "overseer"] as const;
export type AgentNotebookKind = (typeof AGENT_NOTEBOOK_KINDS)[number];

const isAgentNotebookKind = (v: string): v is AgentNotebookKind => (AGENT_NOTEBOOK_KINDS as readonly string[]).includes(v);

/** The default slug for an agent's kernel (owner comes from the Kaggle ref/token). */
export function agentKernelSlug(agent: AgentNotebookKind): string {
  return `ostra-${agent}-agent`;
}

/**
 * Substitute this notebook's agent identity into the canonical bootstrap. Only the single
 * `OSTRA_AGENT = "..."` line is touched, and it MUST match exactly or the build fails loudly rather
 * than shipping a notebook whose identity silently stayed on another role.
 */
export function renderAgentBootstrap(template: string, agent: AgentNotebookKind): string {
  const line = /^OSTRA_AGENT = "[a-z]+"$/m;
  if (!line.test(template)) {
    throw new Error("kaggle-agent-bootstrap.py has no OSTRA_AGENT identity line to substitute");
  }
  return template.replace(line, `OSTRA_AGENT = "${agent}"`);
}

function pyCell(source: string) {
  return {
    cell_type: "code",
    execution_count: null,
    metadata: {},
    outputs: [],
    source: source.split("\n").map((l, i, all) => (i === all.length - 1 ? l : `${l}\n`)),
  };
}

function mdCell(source: string) {
  return {
    cell_type: "markdown",
    metadata: {},
    source: source.split("\n").map((l, i, all) => (i === all.length - 1 ? l : `${l}\n`)),
  };
}

/** The install cell: everything the server and the tunnel need, installed where Kaggle can import it. */
export function installCell(): string {
  return [
    "# ── Ostra Studio: agent notebook install (managed cell) ──",
    "import subprocess, sys",
    "subprocess.run(",
    "    [sys.executable, \"-m\", \"pip\", \"install\", \"-q\",",
    "     \"fastapi\", \"uvicorn\", \"pyngrok\", \"transformers>=4.51\", \"accelerate\", \"sentencepiece\", \"protobuf\"],",
    "    check=True,",
    ")",
    "print(\"[ostra] agent notebook dependencies installed\")",
  ].join("\n");
}

/** The model server cell: the exact OpenAI-compatible contract the Ostra backend calls. */
export function modelServerCell(agent: AgentNotebookKind): string {
  const profile = AGENT_ROSTER.find((a) => a.kind === agent);
  const label = profile?.label ?? agent;
  return [
    "# ── Ostra Studio: agent chat server (managed cell) ──",
    `# Serves the ${label} on :8000 as an OpenAI-compatible chat endpoint, which is exactly what`,
    "# apps/api/src/lib/agentRuntime.ts calls (POST /v1/chat/completions). The agent's ROLE comes from",
    "# the prompt the backend sends, so the same small model can be Script/Image/Voice; this notebook's",
    "# identity is what makes it a distinct, separately-runnable agent.",
    "import threading",
    "",
    "import torch",
    "import uvicorn",
    "from fastapi import FastAPI",
    "from pydantic import BaseModel",
    "from transformers import AutoModelForCausalLM, AutoTokenizer",
    "",
    'MODEL_ID = "Qwen/Qwen3-1.7B"',
    "tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)",
    'model = AutoModelForCausalLM.from_pretrained(MODEL_ID, torch_dtype="auto", device_map="auto")',
    "",
    "app = FastAPI()",
    "",
    "class ChatRequest(BaseModel):",
    "    model: str | None = None",
    "    messages: list = []",
    "    temperature: float | None = 0.4",
    "    max_tokens: int | None = 512",
    "    stream: bool | None = False",
    "",
    '@app.get("/health")',
    "def health():",
    `    return {"ok": True, "agent": "${agent}", "model": MODEL_ID}`,
    "",
    '@app.post("/v1/chat/completions")',
    "def chat(req: ChatRequest):",
    "    text = tokenizer.apply_chat_template(req.messages, tokenize=False, add_generation_prompt=True)",
    '    inputs = tokenizer([text], return_tensors="pt").to(model.device)',
    "    max_new = min(int(req.max_tokens or 512), 1024)",
    "    temperature = max(float(req.temperature or 0.4), 0.01)",
    "    generated = model.generate(",
    "        **inputs,",
    "        max_new_tokens=max_new,",
    "        do_sample=temperature > 0,",
    "        temperature=temperature,",
    "    )",
    '    answer = tokenizer.decode(generated[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)',
    '    return {"id": "ostra", "object": "chat.completion", "model": MODEL_ID,',
    '            "choices": [{"index": 0, "message": {"role": "assistant", "content": answer}, "finish_reason": "stop"}]}',
    "",
    "def _serve():",
    "    uvicorn.run(app, host=\"0.0.0.0\", port=8000, log_level=\"warning\")",
    "",
    "threading.Thread(target=_serve, daemon=True).start()",
    `print("[ostra] ${label} chat server starting on :8000 (model load can take a few minutes)")`,
  ].join("\n");
}

/** Wait for the local server. Never raises — a dead server is proven by the tunnel check, not a crash. */
export function readinessCell(): string {
  return [
    "# ── Ostra Studio: local API readiness check (managed cell) ──",
    "# The server runs in a background thread and the model may take minutes to load. Requesting it",
    "# straight away used to raise ConnectionRefused and abort the whole run, so the tunnel + worker",
    "# bootstrap cells never ran. This waits, prints the real response, and never raises.",
    "import json",
    "import time",
    "",
    "import requests",
    "",
    'URL = "http://127.0.0.1:8000/health"',
    "DEADLINE = time.time() + 600",
    "ready = False",
    "response = None",
    "while time.time() < DEADLINE:",
    "    try:",
    "        response = requests.get(URL, timeout=5)",
    "        ready = True",
    "        break",
    "    except Exception as exc:",
    '        print(f"[ostra] {URL} not ready yet ({exc.__class__.__name__}) — retrying")',
    "        time.sleep(5)",
    "",
    "if ready:",
    '    print("Status:", response.status_code)',
    "    print(json.dumps(response.json(), indent=2))",
    "else:",
    '    print("[ostra] local API did not answer within 600s — continuing anyway (tunnel + bootstrap still run)")',
  ].join("\n");
}

/** The ngrok tunnel cell, identical in behaviour to the Script AI notebook's managed tunnel cell. */
export function tunnelCell(agent: AgentNotebookKind): string {
  return [
    "# ── Ostra Studio: public tunnel via ngrok (managed cell) ──",
    "# Opens the public URL the Ostra backend reaches this agent at. If ngrok fails, this reports it",
    "# and keeps going with PUBLIC_URL = None instead of aborting the run before the bootstrap cell.",
    "#",
    `# This agent looks for its OWN token first (NGROK_AUTHTOKEN_${agent.toUpperCase()}), then falls back to`,
    "# NGROK_AUTHTOKEN. ngrok's free plan allows one tunnel at a time, so give each agent a token from a",
    "# DIFFERENT ngrok account to run them together; all three can live in one Kaggle account's secrets.",
    "from kaggle_secrets import UserSecretsClient",
    "from pyngrok import ngrok",
    "",
    'PUBLIC_URL = globals().get("PUBLIC_URL") or None',
    "",
    "try:",
    "    secrets = UserSecretsClient()",
    "    token = None",
    `    for _name in ("NGROK_AUTHTOKEN_${agent.toUpperCase()}", "NGROK_AUTHTOKEN"):`,
    "        try:",
    "            token = secrets.get_secret(_name)",
    "        except Exception:",
    "            token = None",
    "        if token:",
    "            break",
    "    if not token:",
    `        raise RuntimeError("no ngrok token: set the Kaggle secret NGROK_AUTHTOKEN_${agent.toUpperCase()} (or NGROK_AUTHTOKEN)")`,
    "    ngrok.set_auth_token(token)",
    '    print("Ngrok authentication successful.")',
    "    tunnel = ngrok.connect(8000)",
    "    PUBLIC_URL = tunnel.public_url",
    '    print("Ostra PUBLIC API:")',
    "    print(PUBLIC_URL)",
    '    print("\\nHealth:")',
    '    print(PUBLIC_URL + "/health")',
    "except Exception as exc:",
    "    PUBLIC_URL = None",
    '    print(f"[ostra] ngrok tunnel FAILED ({exc.__class__.__name__}: {exc}) — no public URL")',
    '    print("[ostra] the agent can still register, but it will have no reachable endpoint.")',
  ].join("\n");
}

/** Compose the whole notebook for one agent. Pure — same input always yields the same notebook. */
export function buildAgentNotebook(agent: AgentNotebookKind, bootstrapTemplate: string) {
  const profile = AGENT_ROSTER.find((a) => a.kind === agent);
  const label = profile?.label ?? agent;
  const cells = [
    mdCell(
      [
        `# Ostra Studio — ${label} (agent runtime)`,
        "",
        "Generated by `scripts/kaggle-agent-notebook.ts`. Run the whole notebook; it boots a chat server,",
        "tunnels it publicly, then registers this agent with the Ostra backend and heartbeats.",
        "",
        `The agent is stored as worker type \`${profile?.workerType ?? agent}\`. Nothing is faked: if the model`,
        "fails to load, the tunnel check reports the truth and the agent never comes ONLINE.",
      ].join("\n")
    ),
    pyCell(installCell()),
    pyCell(modelServerCell(agent)),
    pyCell(readinessCell()),
    pyCell(tunnelCell(agent)),
    pyCell(renderAgentBootstrap(bootstrapTemplate, agent)),
  ];
  // Cells need ids (nbformat >= 4.5) and the notebook needs a kernelspec, or Papermill aborts with
  // "No kernel name found in notebook and no override provided" before a single cell runs.
  const withIds = cells.map((c, i) => ({ ...c, id: `ostra-${agent}-${i}` }));
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python", version: "3.12" },
    },
    cells: withIds,
  };
}

type Args = { agents: AgentNotebookKind[]; apply: boolean; dump: boolean; owner: string | null; kernelRef: string | null; slug: string | null };

function parseArgs(argv: string[]): Args {
  const agents: AgentNotebookKind[] = [];
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    if (isAgentNotebookKind(body)) agents.push(body);
    const named = body.startsWith("agent=") ? body.slice("agent=".length).trim() : "";
    if (isAgentNotebookKind(named)) agents.push(named);
  }
  const ownerArg = argv.find((a) => a.startsWith("--owner="))?.slice("--owner=".length).trim();
  const refArg = argv.find((a) => a.startsWith("--kernel-ref="))?.slice("--kernel-ref=".length).trim();
  const slugArg = argv.find((a) => a.startsWith("--slug="))?.slice("--slug=".length).trim();
  return { agents: [...new Set(agents)], apply: argv.includes("--apply"), dump: argv.includes("--dump"), owner: ownerArg || null, kernelRef: refArg || null, slug: slugArg || null };
}

/** List this account's Ostra kernels with their last run time, so a stuck/missing kernel is visible. */
export async function listKernels(authHeader: string): Promise<number> {
  const url = `${KAGGLE_API}/kernels/list?group=profile&pageSize=100&search=ostra`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: authHeader }, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    console.log(`  GET ${url} -> unreachable: ${e instanceof Error ? e.message : String(e)}`);
    return 3;
  }
  console.log(`  GET ${url} -> HTTP ${res.status}`);
  if (!res.ok) {
    console.log(`  body: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    return res.status === 401 || res.status === 403 ? 3 : 1;
  }
  const data = (await res.json().catch(() => null)) as unknown;
  const items: Array<Record<string, unknown>> = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : ((data as { kernels?: Array<Record<string, unknown>> } | null)?.kernels ?? []);
  for (const k of items) {
    console.log(`  ${String(k.ref ?? k.slug ?? "?")} | lastRun=${String(k.lastRunTime ?? "never")} | title=${String(k.title ?? "-")}`);
  }
  if (items.length === 0) console.log("  (no kernels matching 'ostra')");
  return 0;
}

async function pushKernel(authHeader: string, owner: string, agent: AgentNotebookKind, source: string, slugOverride?: string | null): Promise<number> {
  const slug = `${owner}/${slugOverride || agentKernelSlug(agent)}`;
  const res = await fetch(`${KAGGLE_API}/kernels/push`, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify({
      slug,
      // Kaggle titles must be unique per account. `overseer` is presented as "Showrunner" to match the
      // UI, which also keeps it distinct from a title an earlier failed create may still hold.
      newTitle: agent === "overseer" ? "Ostra Showrunner agent" : `Ostra ${agent} agent`,
      text: source,
      language: "python",
      kernelType: "notebook",
      isPrivate: true,
      enableInternet: true,
      enableGpu: true,
      enableTpu: false,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const raw = await res.text().catch(() => "");
  console.log(`  POST /kernels/push (${slug}) -> HTTP ${res.status}`);
  if (!res.ok) {
    console.log(`  body: ${raw.slice(0, 300)}`);
    console.log("  RESULT: PUSH FAILED — the notebook was not created.");
    return res.status === 401 || res.status === 403 ? 3 : 1;
  }
  let parsed: Record<string, unknown> = {};
  try { parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}; } catch { parsed = {}; }
  console.log(`  versionNumber=${String(parsed.versionNumber)} url=${String(parsed.url ?? "(none)")}`);
  console.log(`  RESULT: PUSHED — the ${agent} agent notebook now exists (private, internet + GPU on).`);
  console.log("  A run is requested, not online: ONLINE requires the notebook to boot, register and heartbeat.");
  return 0;
}

export async function main(argv = process.argv): Promise<number> {
  console.log("=== Ostra Studio: Kaggle agent notebook builder ===");
  console.log(`at ${new Date().toISOString()}\n`);

  const args = parseArgs(argv);
  const cfg = kaggleConfig();
  const apiToken = cfg.apiToken ?? process.env.KAGGLE_API_TOKEN?.trim();

  if (argv.includes("--list")) {
    if (!apiToken) {
      console.log("  RESULT: NOT_CONFIGURED — KAGGLE_API_TOKEN is not set.");
      return 2;
    }
    console.log("--- kernels on this account (search: ostra) ---");
    return listKernels(getKaggleAuthHeader(apiToken));
  }

  if (args.agents.length === 0) {
    console.log(`  RESULT: NOT_CONFIGURED — pass one or more of ${AGENT_NOTEBOOK_KINDS.map((a) => `--${a}`).join(", ")}, or --list`);
    return 2;
  }

  const bootstrap = readFileSync(BOOTSTRAP_PATH, "utf8");
  const kernelRef = args.kernelRef ?? cfg.kernelRef ?? null;
  const { owner: refOwner } = kernelRef ? parseKernelRef(kernelRef) : { owner: null };
  const owner = args.owner ?? refOwner ?? DEFAULT_OWNER;

  for (const agent of args.agents) {
    const notebook = buildAgentNotebook(agent, bootstrap);
    const source = JSON.stringify(notebook);
    console.log(`--- ${agent} ---`);
    console.log(`  cells: ${notebook.cells.length}, source: ${source.length} chars, slug: ${owner}/${agentKernelSlug(agent)}`);
    if (args.dump) {
      notebook.cells.forEach((c, i) => {
        const src = Array.isArray(c.source) ? c.source.join("") : String(c.source);
        console.log(`\n===== cell ${i} [${c.cell_type}] =====`);
        console.log(src);
      });
    }
  }

  if (args.dump || !args.apply) {
    console.log("\n  RESULT: DRY RUN — re-run with --apply to create/update the real kernels.");
    return 0;
  }
  if (!apiToken) {
    console.log("  RESULT: NOT_CONFIGURED — KAGGLE_API_TOKEN is not set.");
    return 2;
  }

  const authHeader = getKaggleAuthHeader(apiToken);
  console.log(`\n--- pushing ${args.agents.length} kernel(s) as ${owner} ---`);
  let exit = 0;
  for (const agent of args.agents) {
    const notebook = buildAgentNotebook(agent, bootstrap);
    const code = await pushKernel(authHeader, owner, agent, JSON.stringify(notebook), args.slug);
    if (code !== 0) exit = code;
  }
  return exit;
}

if (import.meta.main) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((e) => { console.error("unexpected failure:", e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
}
