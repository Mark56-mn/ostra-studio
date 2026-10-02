#!/usr/bin/env bun
/**
 * Create or refresh a Kaggle notebook for a non-script agent (Image AI / Voice AI / Showrunner).
 *
 * The Script AI notebook already exists and is operator-managed. This script composes a NEW notebook
 * for one agent role out of cells that are all in this repo:
 *
 *   1. install cell        — fastapi/uvicorn/transformers/accelerate/pyngrok
 *   2. model server cell   — picks the strongest model this GPU can serve (OSTRA_MODEL secret
 *                            overrides; OSTRA_MODEL_DEFAULT pins a choice; else VRAM decides), then
 *                            serves OpenAI-compatible chat on :8000 (the SAME contract the Ostra
 *                            backend calls: POST /v1/chat/completions, GET /health)
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
 *   bun scripts/kaggle-agent-notebook.ts --agent=all --apply       # every agent, token #(i+1) per agent
 *   bun scripts/kaggle-agent-notebook.ts --agent=image --token=2 --apply  # pin one agent to one token
 *   bun scripts/kaggle-agent-notebook.ts --list                    # list kernels per configured token
 *   bun scripts/kaggle-agent-notebook.ts --list --token=2          # only token #2's account
 *   bun scripts/kaggle-model-benchmark.ts --apply                  # measure candidate models on the real GPU
 *
 * Multiple Kaggle accounts are supported: the workspace may hold KAGGLE_API_TOKEN plus numbered
 * tokens (KAGGLE_API_TOKEN_1, KAGGLE_API_TOKEN_2, …). Every token belongs to exactly ONE Kaggle
 * account, so before each push the script probes the real account via an authenticated list call and
 * REFUSES to push if the target owner does not match — a mismatched --owner/--token pairing fails
 * loudly here instead of creating a notebook under the wrong account (or a confusing 403).
 *
 * Exit codes: 0 ok | 2 NOT_CONFIGURED | 3 AUTH_FAILED/unreachable | 1 other failure
 */

import { readFileSync } from "node:fs";
import { AGENT_ROSTER, kaggleConfig, kaggleApiTokens, getKaggleAuthHeader, parseKernelRef, inferKaggleOwnerFromToken } from "../packages/shared/src/index";

const KAGGLE_API = "https://www.kaggle.com/api/v1";
const BOOTSTRAP_PATH = new URL("./kaggle-agent-bootstrap.py", import.meta.url).pathname;
const DEFAULT_OWNER = "bettertrade";

/** The roles this script can build. Script AI keeps its own operator-managed notebook. */
export const AGENT_NOTEBOOK_KINDS = ["image", "voice", "overseer"] as const;
export type AgentNotebookKind = (typeof AGENT_NOTEBOOK_KINDS)[number];

const isAgentNotebookKind = (v: string): v is AgentNotebookKind => (AGENT_NOTEBOOK_KINDS as readonly string[]).includes(v);

/** The default slug for an agent's kernel (owner comes from the Kaggle ref/token). */
export function agentKernelSlug(agent: AgentNotebookKind): string {
  // The showrunner notebook was created as `ostra-showrunner-agent`, so the builder must target that
  // slug: pushing `ostra-overseer-agent` with the same title fails 409 (title already in use) and
  // would leave the live showrunner notebook un-updated.
  if (agent === "overseer") return "ostra-showrunner-agent";
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
    "# Model choice: the strongest model this GPU can actually serve. OSTRA_MODEL (Kaggle secret)",
    "# overrides; OSTRA_MODEL_DEFAULT (injected by the generator) pins a deliberate choice; otherwise",
    "# free VRAM is measured and the model steps up only when it fits — an OOM here would kill the",
    "# run before tunnel + registration ever happen.",
    "import os",
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
    "MODEL_ID = _osecret(\"OSTRA_MODEL\") or globals().get(\"OSTRA_MODEL_DEFAULT\") or (",
    "    # 14.0 GiB, not 15.0: Kaggle's T4 reports 14.6 GiB total, so a 15.0 gate made Qwen3-4B",
    "    # unreachable in practice. Measured on bettertrade/ostra-model-benchmark: Qwen3-4B peaked at",
    "    # 7.51 GiB on that same T4 and ran at 12.44 tok/s vs 1.7B's 13.6 — it fits, so use it.",
    "    \"Qwen/Qwen3-4B\" if (_GPU_OK and _VRAM_GIB >= 14.0) else \"Qwen/Qwen3-1.7B\"",
    ")",
    "print(f\"[ostra] model selected: {MODEL_ID} (gpu={_GPU_OK}, vram={_VRAM_GIB:.1f} GiB)\")",
    "tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)",
    "model = AutoModelForCausalLM.from_pretrained(MODEL_ID, torch_dtype=\"auto\", device_map=\"auto\")",
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
    "@app.get(\"/health\")",
    "def health():",
    `    return {"ok": True, "agent": "${agent}", "model": MODEL_ID}`,
    "",
    "@app.post(\"/v1/chat/completions\")",
    "def chat(req: ChatRequest):",
    "    text = tokenizer.apply_chat_template(req.messages, tokenize=False, add_generation_prompt=True)",
    "    inputs = tokenizer([text], return_tensors=\"pt\").to(model.device)",
    "    max_new = min(int(req.max_tokens or 512), 1024)",
    "    temperature = max(float(req.temperature or 0.4), 0.01)",
    "    generated = model.generate(",
    "        **inputs,",
    "        max_new_tokens=max_new,",
    "        do_sample=temperature > 0,",
    "        temperature=temperature,",
    "    )",
    "    answer = tokenizer.decode(generated[0][inputs[\"input_ids\"].shape[1]:], skip_special_tokens=True)",
    "    return {\"id\": \"ostra\", \"object\": \"chat.completion\", \"model\": MODEL_ID,",
    "            \"choices\": [{\"index\": 0, \"message\": {\"role\": \"assistant\", \"content\": answer}, \"finish_reason\": \"stop\"}]}",
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
    "URL = \"http://127.0.0.1:8000/health\"",
    "DEADLINE = time.time() + 600",
    "ready = False",
    "response = None",
    "while time.time() < DEADLINE:",
    "    try:",
    "        response = requests.get(URL, timeout=5)",
    "        ready = True",
    "        break",
    "    except Exception as exc:",
    "        print(f\"[ostra] {URL} not ready yet ({exc.__class__.__name__}) — retrying\")",
    "        time.sleep(5)",
    "",
    "if ready:",
    "    print(\"Status:\", response.status_code)",
    "    print(json.dumps(response.json(), indent=2))",
    "else:",
    "    print(\"[ostra] local API did not answer within 600s — continuing anyway (tunnel + bootstrap still run)\")",
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
    "PUBLIC_URL = globals().get(\"PUBLIC_URL\") or None",
    "",
    "try:",
    "    secrets = UserSecretsClient()",
    "    token = None",
    "    _errors = []",
    `    _labels = ("NGROK_AUTHTOKEN_${agent.toUpperCase()}", "NGROK_AUTHTOKEN", "ngrok_authtoken_${agent}", "ngrok_authtoken")`,
    "    for _name in _labels:",
    "        try:",
    "            token = secrets.get_secret(_name)",
    "        except Exception as _exc:",
    "            token = None",
    "            _errors.append(f\"{_name} -> {_exc.__class__.__name__}: {str(_exc)[:100]}\")",
    "        if token:",
    "            print(f\"[ostra] ngrok token read from Kaggle secret '{_name}'\")",
    "            break",
    "    if not token:",
    "        # 'Secret not found' and 'no secret attached to this notebook' look identical from the",
    "        # outside, and the fix differs. Ask the service with a label that cannot exist and report",
    "        # its real answer. One short print per line: Kaggle's log API truncates long lines (~200",
    "        # chars), which is exactly how the first version of this diagnostic became useless.",
    "        print(\"[ostra] ngrok secret lookup failed for this notebook\")",
    "        for _e in _errors:",
    "            print(f\"[ostra]   tried {_e}\")",
    "        try:",
    "            secrets.get_secret(\"__ostra_secret_probe__\")",
    "            print(\"[ostra]   probe __ostra_secret_probe__ unexpectedly resolved\")",
    "        except Exception as _exc:",
    "            print(f\"[ostra]   probe __ostra_secret_probe__ -> {_exc.__class__.__name__}: {str(_exc)[:100]}\")",
    "        print(\"[ostra]   fix: secrets must be ATTACHED, not just created (Add-ons > Secrets, tick THIS notebook)\")",
    "        raise RuntimeError(\"no ngrok token from Kaggle secrets (see the [ostra] lines above)\")",
    "    ngrok.set_auth_token(token)",
    "    print(\"Ngrok authentication successful.\")",
    "    tunnel = ngrok.connect(8000)",
    "    PUBLIC_URL = tunnel.public_url",
    "    print(\"Ostra PUBLIC API:\")",
    "    print(PUBLIC_URL)",
    "    print(\"\\nHealth:\")",
    "    print(PUBLIC_URL + \"/health\")",
    "except Exception as exc:",
    "    PUBLIC_URL = None",
    "    print(f\"[ostra] ngrok tunnel FAILED ({exc.__class__.__name__}: {exc}) — no public URL\")",
    "    print(\"[ostra] the agent can still register, but it will have no reachable endpoint.\")",
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

type Args = { agents: AgentNotebookKind[]; apply: boolean; dump: boolean; owner: string | null; kernelRef: string | null; slug: string | null; tokenSel: string | null };

/** Resolve --token=<n|all> against the tokens kaggleApiTokens() found, by 1-based index. */
function resolveTokenSelection(sel: string | null, tokens: string[]): number[] {
  if (!sel || sel === "all") return tokens.map((_, i) => i);
  const n = Number.parseInt(sel, 10);
  if (!Number.isInteger(n) || n < 1 || n > tokens.length) {
    throw new Error(`--token=${sel} is out of range: ${tokens.length} token(s) configured`);
  }
  return [n - 1];
}

function parseArgs(argv: string[]): Args {
  const agents: AgentNotebookKind[] = [];
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    if (body === "all") {
      agents.push(...AGENT_NOTEBOOK_KINDS);
      continue;
    }
    if (isAgentNotebookKind(body)) agents.push(body);
    const named = body.startsWith("agent=") ? body.slice("agent=".length).trim() : "";
    if (named === "all") {
      agents.push(...AGENT_NOTEBOOK_KINDS);
      continue;
    }
    if (isAgentNotebookKind(named)) agents.push(named);
  }
  const ownerArg = argv.find((a) => a.startsWith("--owner="))?.slice("--owner=".length).trim();
  const refArg = argv.find((a) => a.startsWith("--kernel-ref="))?.slice("--kernel-ref=".length).trim();
  const slugArg = argv.find((a) => a.startsWith("--slug="))?.slice("--slug=".length).trim();
  const tokenArg = argv.find((a) => a.startsWith("--token="))?.slice("--token=".length).trim();
  return { agents: [...new Set(agents)], apply: argv.includes("--apply"), dump: argv.includes("--dump"), owner: ownerArg || null, kernelRef: refArg || null, slug: slugArg || null, tokenSel: tokenArg || null };
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

/**
 * Who does this token actually belong to? Built from a REAL authenticated list call — never guessed
 * from the token's shape, so a mis-paired --token/--owner combination fails loudly here instead of
 * creating a notebook under the wrong account (or a confusing 403).
 *
 * A brand-new account may own no kernels, datasets or models, in which case the owner cannot be
 * READ even though the token is perfectly valid — that state is reported as authenticated with
 * owner:null, never as an auth failure. Callers may then push with an explicit --owner= and let
 * Kaggle itself arbitrate (a wrong account fails the push with a real 403).
 */
export async function probeAccount(authHeader: string): Promise<{ owner: string | null; error: string | null; authenticated: boolean }> {
  const readOwner = async (url: string): Promise<{ owner: string | null; error: string | null; authenticated: boolean }> => {
    try {
      const res = await fetch(url, { headers: { Authorization: authHeader }, signal: AbortSignal.timeout(15000) });
      if (res.status === 401 || res.status === 403) return { owner: null, error: `HTTP ${res.status} — token rejected`, authenticated: false };
      if (!res.ok) return { owner: null, error: `HTTP ${res.status}`, authenticated: true };
      const data = (await res.json().catch(() => null)) as unknown;
      const items: Array<Record<string, unknown>> = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : ((data as { kernels?: Array<Record<string, unknown>> } | null)?.kernels ?? []);
      for (const k of items) {
        // Refs arrive as "owner/slug" from list calls, but some endpoints return "/code/owner/slug".
        const ref = String(k.ref ?? "").replace(/^\/+/u, "").replace(/^code\//u, "");
        if (ref.includes("/")) return { owner: ref.split("/")[0], error: null, authenticated: true };
      }
      return { owner: null, error: null, authenticated: true };
    } catch (e) {
      return { owner: null, error: e instanceof Error ? e.message : String(e), authenticated: false };
    }
  };

  // Kernels first (what we actually push); datasets and models are the fallbacks for accounts that
  // own nothing yet. All three are account-scoped reads whose refs carry the owner — none mutate.
  for (const url of [
    `${KAGGLE_API}/kernels/list?group=profile&pageSize=1`,
    `${KAGGLE_API}/datasets/list?group=my&pageSize=1`,
    `${KAGGLE_API}/models/list?group=my&pageSize=1`,
  ]) {
    const r = await readOwner(url);
    if (r.owner) return r;
    if (!r.authenticated) return r; // 401/403 or unreachable — do not fall through
  }
  return { owner: null, error: null, authenticated: true };
}

/**
 * A PRIVATE kernel is pullable only by its owner, so trying to pull a known-private kernel from
 * another token's account settles "same account or different" for a token whose owner cannot be
 * listed (fresh account) — read-only, and never guesses a username.
 */
export async function canReadPrivateKernel(authHeader: string, owner: string, slug: string): Promise<boolean> {
  const url = `${KAGGLE_API}/kernels/pull?user_name=${encodeURIComponent(owner)}&kernel_slug=${encodeURIComponent(slug)}`;
  try {
    const res = await fetch(url, { headers: { Authorization: authHeader }, signal: AbortSignal.timeout(15000) });
    return res.ok;
  } catch {
    return false;
  }
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
  const tokens = kaggleApiTokens();

  // --whoami: per-token identity diagnostics. Read-only; distinguishes "same account as the
  // operator kernels" from "a different account" even when the probed account is empty.
  if (argv.includes("--whoami")) {
    if (tokens.length === 0) {
      console.log("  RESULT: NOT_CONFIGURED — no KAGGLE_API_TOKEN / KAGGLE_API_TOKEN_<n> is set.");
      return 2;
    }
    const refToken = tokens[0];
    const kernelRef = args.kernelRef ?? cfg.kernelRef ?? null;
    const { owner: refOwner } = kernelRef ? parseKernelRef(kernelRef) : { owner: null };
    const knownOwner = refOwner ?? DEFAULT_OWNER;
    let exit = 0;
    for (let i = 0; i < tokens.length; i++) {
      const authHeader = getKaggleAuthHeader(tokens[i]);
      const probe = await probeAccount(authHeader);
      console.log(`--- token #${i + 1} ---`);
      if (!probe.authenticated) {
        console.log(`  REJECTED by Kaggle (${probe.error ?? "unauthenticated"})`);
        exit = 3;
        continue;
      }
      if (probe.owner) {
        console.log(`  account: ${probe.owner}`);
      } else {
        console.log("  account: (owns no kernels/datasets/models — owner not listable)");
      }
      const sameAsKnown = await canReadPrivateKernel(authHeader, knownOwner, agentKernelSlug("image"));
      console.log(`  can pull ${knownOwner}/${agentKernelSlug("image")} (private): ${sameAsKnown ? "YES — this is the same account" : "no — a different account"}`);
    }
    return exit;
  }

  if (argv.includes("--list")) {
    if (tokens.length === 0) {
      console.log("  RESULT: NOT_CONFIGURED — no KAGGLE_API_TOKEN / KAGGLE_API_TOKEN_<n> is set.");
      return 2;
    }
    let indices: number[];
    try {
      indices = resolveTokenSelection(args.tokenSel, tokens);
    } catch (e) {
      console.log(`  RESULT: ERROR — ${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }
    let exit = 0;
    for (const i of indices) {
      const token = tokens[i];
      const guessed = inferKaggleOwnerFromToken(token);
      console.log(`\n--- token #${i + 1}${guessed ? ` (embedded owner: ${guessed})` : " (embedded owner not readable)"} ---`);
      const probe = await probeAccount(getKaggleAuthHeader(token));
      if (!probe.authenticated) {
        console.log(`  account probe FAILED: ${probe.error ?? "token rejected"} — skipping this account's list`);
        exit = 3;
        continue;
      }
      if (!probe.owner) {
        console.log("  account: (token valid; the account owns no kernels/datasets/models — owner cannot be read)");
      } else {
        console.log(`  account: ${probe.owner}`);
      }
      const code = await listKernels(getKaggleAuthHeader(token));
      if (code !== 0) exit = code;
    }
    return exit;
  }

  if (args.agents.length === 0) {
    console.log(`  RESULT: NOT_CONFIGURED — pass one or more of ${AGENT_NOTEBOOK_KINDS.map((a) => `--${a}`).join(", ")}, --agent=all, or --list`);
    return 2;
  }
  if (args.tokenSel && args.tokenSel !== "all" && args.agents.length !== 1) {
    console.log("  --token=<n> pins ONE agent to one account; use --agent=all (or repeat --agent) without it to map agents across tokens.");
    return 2;
  }

  const bootstrap = readFileSync(BOOTSTRAP_PATH, "utf8");
  // KAGGLE_KERNEL_REF belongs to the Script AI notebook (scripts/kaggle-sync-notebook.ts). Honouring it
  // here silently aimed every AGENT push at that one account: `--agent=image --token=2` was REFUSED
  // because the env ref said "bettertrade" while the token owns "kidscity". Only an explicit
  // --kernel-ref=/--owner= may pin an agent notebook now.
  const kernelRef = args.kernelRef ?? null;
  if (!args.kernelRef && cfg.kernelRef) {
    console.log(`  NOTE: ignoring KAGGLE_KERNEL_REF=${cfg.kernelRef} (Script AI notebook) — pass --owner=<account> to pin an agent notebook explicitly.`);
  }
  const { owner: refOwner } = kernelRef ? parseKernelRef(kernelRef) : { owner: null };
  const pinnedOwner = args.owner ?? refOwner ?? null;

  for (const agent of args.agents) {
    const notebook = buildAgentNotebook(agent, bootstrap);
    const source = JSON.stringify(notebook);
    const shownOwner = pinnedOwner;
    console.log(`--- ${agent} ---`);
    // The owner is the TOKEN's account, decided below — printing a guessed one here (it used to say
    // "bettertrade" while pushing to kidscity) makes the plan output lie about where work lands.
    console.log(`  cells: ${notebook.cells.length}, source: ${source.length} chars, slug: ${agentKernelSlug(agent)} (owner = the token's account${shownOwner ? `, pinned to ${shownOwner}` : ""})`);
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
  if (tokens.length === 0) {
    console.log("  RESULT: NOT_CONFIGURED — no KAGGLE_API_TOKEN / KAGGLE_API_TOKEN_<n> is set.");
    return 2;
  }

  // Per-agent token selection. --token=<n> pins one; otherwise agent #i uses token #(i+1) in order,
  // wrapping when there are more agents than tokens (one account may legitimately own several agents).
  let pinnedIndex: number | null = null;
  try {
    if (args.tokenSel && args.tokenSel !== "all") pinnedIndex = resolveTokenSelection(args.tokenSel, tokens)[0];
  } catch (e) {
    console.log(`  RESULT: ERROR — ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }

  console.log(`\n--- pushing ${args.agents.length} kernel(s) ---`);
  let exit = 0;
  for (let i = 0; i < args.agents.length; i++) {
    const agent = args.agents[i];
    const tokenIdx = pinnedIndex ?? i % tokens.length;
    const token = tokens[tokenIdx];
    const authHeader = getKaggleAuthHeader(token);
    const probe = await probeAccount(authHeader);
    if (!probe.authenticated) {
      console.log(`  ${agent}: account probe FAILED for token #${tokenIdx + 1} (${probe.error ?? "token rejected"}) — push aborted for this agent.`);
      exit = 3;
      continue;
    }
    // Valid but unidentifiable account: only an explicit --owner can name the target, and Kaggle
    // itself arbitrates — a wrong account fails the push with a real 403, nothing is fabricated.
    if (!probe.owner && !pinnedOwner) {
      console.log(`  ${agent}: token #${tokenIdx + 1} is valid but its account owns no kernels/datasets/models, so its owner cannot be read. Re-run with --owner=<account>.`);
      exit = 1;
      continue;
    }
    const targetOwner = pinnedOwner ?? probe.owner!;
    if (probe.owner && targetOwner !== probe.owner) {
      console.log(`  ${agent}: REFUSING — token #${tokenIdx + 1} owns account "${probe.owner}" but the push targets "${targetOwner}". Re-run with --owner=${probe.owner}, or drop --owner/--kernel-ref to use the token's own account.`);
      exit = 1;
      continue;
    }
    console.log(`  ${agent}: pushing to ${targetOwner} (token #${tokenIdx + 1}${probe.owner ? "" : ", owner unverified — Kaggle will reject a wrong account"})`);
    const code = await pushKernel(authHeader, targetOwner, agent, JSON.stringify(buildAgentNotebook(agent, bootstrap)), args.slug);
    if (code !== 0) exit = code;
  }
  return exit;
}

if (import.meta.main) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((e) => { console.error("unexpected failure:", e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
}
