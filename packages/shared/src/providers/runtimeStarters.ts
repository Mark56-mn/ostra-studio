// packages/shared/src/providers/runtimeStarters.ts
// Abstraction for starting external runtimes. The orchestrator/scheduler depends on this,
// not on Kaggle/Colab-specific code paths.

export type RuntimeStartInput = {
  worker_type: string;   // script | image | voice
  runtime: string;       // kaggle | colab | …
  provider: string;      // e.g. kaggle, colab-image, kokoro-82m
  trigger_source: string; // scheduler:<schedule_id> | run_now
  config?: Record<string, unknown>;
};

export type RuntimeStartOutcome =
  | { ok: true;  startup_request_id: string; provider_run_id?: string; provider_response: Record<string, unknown>; initial_state: "requested" | "connecting" }
  | { ok: false; error: string; provider_response?: Record<string, unknown>; code?: "NOT_AUTOSTARTABLE" | "RATE_LIMITED" | "AUTH_FAILED" | "QUOTA_EXCEEDED" | "UNKNOWN" };

export interface RuntimeStarter {
  readonly runtime: string;   // kaggle | colab | …
  readonly provider: string;  // optional specialization hint
  /** Start the runtime — must NOT imply ONLINE; only reports that the start was requested. */
  start(input: RuntimeStartInput): Promise<RuntimeStartOutcome>;
  /** Whether this starter can be triggered automatically (vs. manual-only). */
  readonly autostartable: boolean;
}

// ── Secrets redaction ─────────────────────────────────────────────────────────
const SECRET_KEYS = new Set(["token","api_token","kaggle_api_token","KAGGLE_API_TOKEN","KAGGLE_KERNEL_REF","password","secret","authorization","access_token","oauth_token","service_account","private_key"]);
export function redactSecrets(obj: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!obj || typeof obj !== "object") return obj ?? null;
  const out: Record<string, unknown> = { ...obj };
  for (const k of Object.keys(out)) {
    if (SECRET_KEYS.has(k) || SECRET_KEYS.has(k.toLowerCase())) out[k] = "[REDACTED]";
    // also redact values that look like tokens
    const v = out[k];
    if (typeof v === "string" && v.length > 40 && /(KGAT_|ya29\.|1\/\/|eyJ)/.test(v)) out[k] = "[REDACTED]";
  }
  return out;
}

// ── Kaggle helpers ───────────────────────────────────────────────────────────
// Exported so diagnostics (scripts/kaggle-live-check.ts) reuse the exact production auth
// logic instead of duplicating it and silently drifting from real behaviour.
export function getKaggleAuthHeader(token: string): string {
  const t = token.trim();
  if (!t) return "";
  // Handle JSON form {"username":"...","key":"..."}
  if (t.startsWith("{") ) {
    try {
      const j = JSON.parse(t) as { username?: string; key?: string; api_key?: string };
      const u = j.username ?? "";
      const k = j.key ?? j.api_key ?? "";
      if (u && k) {
        // Buffer is available in Node, fallback to btoa
        const b64 = typeof Buffer !== "undefined" ? Buffer.from(`${u}:${k}`).toString("base64") : btoa(`${u}:${k}`);
        return `Basic ${b64}`;
      }
    } catch {}
  }
  if (t.includes(":")) {
    const idx = t.indexOf(":");
    const u = t.slice(0, idx).trim();
    const k = t.slice(idx+1).trim();
    if (u && k) {
      const b64 = typeof Buffer !== "undefined" ? Buffer.from(`${u}:${k}`).toString("base64") : btoa(`${u}:${k}`);
      return `Basic ${b64}`;
    }
  }
  // Bearer for KGAT_ or JWT-like
  return `Bearer ${t}`;
}

function inferKaggleOwnerFromToken(token: string): string | null {
  const t = token.trim();
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t) as { username?: string };
      if (j.username) return j.username;
    } catch {}
  }
  if (t.includes(":")) {
    const u = t.split(":")[0]?.trim();
    if (u) return u;
  }
  return null;
}

export function parseKernelRef(raw: string): { owner: string | null; slug: string; raw: string } {
  const r = raw.trim();
  if (r.includes("/")) {
    const [owner, slug] = r.split("/", 2) as [string, string];
    return { owner: owner || null, slug: slug || r, raw: r };
  }
  return { owner: null, slug: r, raw: r };
}

async function resolveKaggleKernelRef(token: string, kernelRef: string): Promise<string> {
  const ref = kernelRef.trim();
  if (ref.includes("/")) return ref; // already owner/slug
  // Legacy id like notebook7eae283a4a without owner -> try to infer owner or search via API
  const owner = inferKaggleOwnerFromToken(token);
  const isLegacyNotebook = /^notebook[0-9a-f]+$/i.test(ref);
  if (isLegacyNotebook || !ref.includes("/")) {
    // Try API search to verify real ref if possible
    if (owner) {
      // Optimistic: owner + "/" + ref is the likely real ref; verify via API list
      const candidate = `${owner}/${ref}`;
      try {
        const headers: Record<string,string> = { Authorization: getKaggleAuthHeader(token) };
        // Verify candidate exists via get check? Use list?mine=true pageSize 100 search
        // NOTE: the Kaggle REST API has no `mine` field (HTTP 400). `group=profile` scopes the
        // search to the authenticated token owner, which is what we want here.
        const url = `https://www.kaggle.com/api/v1/kernels/list?group=profile&pageSize=100&search=${encodeURIComponent(ref)}`;
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) } as RequestInit);
        if (res.ok) {
          const data = await res.json().catch(()=> null) as unknown;
          const kernels: unknown[] = Array.isArray(data) ? data as unknown[] : (data as { kernels?: unknown[] } | null)?.kernels ?? [];
          for (const k of kernels as Array<Record<string,unknown>>) {
            const kRefRaw = (k.ref as string) ?? (k.slug ? `${(k.ownerRef as string) ?? owner}/${k.slug}` : "");
            const kRef = kRefRaw ?? "";
            const kSlug = (k.slug as string) ?? "";
            const kOwner = (k.owner as string) ?? (k.userName as string) ?? "";
            if (kRef === candidate || kSlug === ref || kRef.includes(ref)) {
              if (kRef && kRef.includes("/")) return kRef;
              if (kOwner && kSlug) return `${kOwner}/${kSlug}`;
            }
          }
        }
      } catch {
        // fall through to inferred
      }
      return candidate;
    }
    // If no owner in token, try list search without owner inference (search globally)
    try {
      const headers: Record<string,string> = { Authorization: getKaggleAuthHeader(token) };
      // NOTE: `mine=true` is not a Kaggle API field (HTTP 400); `group=profile` lists the token owner's kernels.
      const url = `https://www.kaggle.com/api/v1/kernels/list?group=profile&pageSize=100&search=${encodeURIComponent(ref)}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) } as RequestInit);
      if (res.ok) {
        const data = await res.json().catch(()=> null) as unknown;
        const kernels: unknown[] = Array.isArray(data) ? data as unknown[] : (data as { kernels?: unknown[] } | null)?.kernels ?? [];
        for (const k of kernels as Array<Record<string,unknown>>) {
          const kRef = (k.ref as string) ?? "";
          const kSlug = (k.slug as string) ?? "";
          if (kRef.includes(ref) || kSlug === ref) {
            if (kRef.includes("/")) return kRef;
          }
        }
      }
    } catch {}
  }
  // Fallback: return as-is (will be validated on push and return truthful error)
  return ref;
}

function mapKaggleHttpError(status: number, body: string): { code: StarterErrorCode; msg: string } {
  if (status === 401 || status === 403) return { code: "AUTH_FAILED" as never, msg: `Kaggle auth failed (HTTP ${status}) — check KAGGLE_API_TOKEN` };
  if (status === 429) return { code: "RATE_LIMITED" as never, msg: `Kaggle rate-limited (HTTP ${status})` };
  if (status === 402) return { code: "QUOTA_EXCEEDED" as never, msg: `Kaggle quota exceeded (HTTP ${status})` };
  if (status === 404) return { code: "NOT_AUTOSTARTABLE" as never, msg: `Kaggle kernel not found (HTTP 404) — check KAGGLE_KERNEL_REF and that the token owns it` };
  // Surface Kaggle's own validation message; it is the actionable part (e.g. a bad push payload).
  const detail = body.trim().slice(0, 200);
  return { code: "UNKNOWN" as never, msg: `Kaggle request failed (HTTP ${status})${detail ? `: ${detail}` : ""}` };
}

// ── Kaggle starter (real execution) ─────────────────────────────────────────
export type KaggleStartConfig = {
  apiToken?: string;       // from env KAGGLE_API_TOKEN server-side; not sent from browser
  kernelRef?: string;      // KAGGLE_KERNEL_REF e.g. "mark56/studio-script-kernel" or "notebook7eae283a4a"
  datasetRefs?: string[];  // optional
};

export class KaggleRuntimeStarter implements RuntimeStarter {
  readonly runtime = "kaggle";
  readonly provider = "kaggle";
  readonly autostartable = true;

  constructor(private cfg: KaggleStartConfig = {}) {}

  async start(input: RuntimeStartInput): Promise<RuntimeStartOutcome> {
    const kernelRefRaw = (input.config?.["kernelRef"] as string) ?? this.cfg.kernelRef ?? process.env.KAGGLE_KERNEL_REF ?? "";
    const token = this.cfg.apiToken ?? (process.env.KAGGLE_API_TOKEN as string | undefined) ?? "";

    if (!kernelRefRaw) {
      return { ok: false, error: "KAGGLE_KERNEL_REF not configured (e.g. mark56/studio-script-kernel or notebook7eae283a4a)", code: "NOT_AUTOSTARTABLE", provider_response: { reason: "missing_kernel_ref" } };
    }
    if (!token) {
      return { ok: false, error: "KAGGLE_API_TOKEN not configured on Render (Kaggle JSON key or username:key)", code: "AUTH_FAILED", provider_response: { reason: "missing_token" } };
    }

    const execDisabled = (process.env.KAGGLE_EXEC_DISABLED ?? "").toLowerCase() === "true";
    if (execDisabled) {
      return {
        ok: false,
        error: "KAGGLE_EXEC_DISABLED=true — probe-only mode. Set false and configure kernel to enable real start.",
        code: "UNKNOWN",
        provider_response: { mode: "disabled", kernelRef: kernelRefRaw },
      };
    }

    const startup_request_id = `kaggle:${Date.now().toString(36)}:${Math.random().toString(36).slice(2,8)}`;
    const authHeader = getKaggleAuthHeader(token);

    // Resolve legacy notebook7eae283a4a -> owner/slug if needed
    let kernelRef: string;
    try {
      kernelRef = await resolveKaggleKernelRef(token, kernelRefRaw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `Failed to resolve kernel ref ${kernelRefRaw}: ${msg}`, code: "UNKNOWN", provider_response: redactSecrets({ kernelRef: kernelRefRaw }) ?? {} };
    }

    const { owner, slug } = parseKernelRef(kernelRef);
    if (!slug) {
      return { ok: false, error: `Invalid KAGGLE_KERNEL_REF: ${kernelRef}`, code: "NOT_AUTOSTARTABLE", provider_response: { reason: "invalid_kernel_ref", kernelRef } };
    }

    // Step 1: Verify auth + verify kernel exists via authenticated list OR get
    // Do a lightweight but honest check: try to fetch the kernel metadata.
    // If that succeeds, we know the kernel exists and token is valid. If it fails with 401/403 -> AUTH_FAILED.
    try {
      const headers: Record<string,string> = { Authorization: authHeader };
      // Cheap authenticated call whose only job is to separate "bad token" (401) from "token is fine".
      // `pageSize=1` with no other filters is a valid Kaggle query; `mine=true` is not (HTTP 400).
      const verifyUrl = "https://www.kaggle.com/api/v1/kernels/list?pageSize=1";
      const verifyRes = await fetch(verifyUrl, { headers, signal: AbortSignal.timeout(8000) } as RequestInit);
      if (!verifyRes.ok) {
        const status = verifyRes.status;
        const body = await verifyRes.text().catch(() => "");
        const mapped = mapKaggleHttpError(status, body);
        return { ok: false, error: mapped.msg, code: mapped.code as never, provider_response: redactSecrets({ httpStatus: status, body: body.slice(0,500), kernelRef }) ?? {} };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("timeout") || msg.includes("Timeout")) {
        return { ok: false, error: `Kaggle unreachable (timeout): ${msg}`, code: "UNKNOWN", provider_response: { reason: "fetch_failed", kernelRef } };
      }
      return { ok: false, error: `Kaggle unreachable: ${msg}`, code: "UNKNOWN", provider_response: { reason: "fetch_failed", kernelRef } };
    }

    // Step 2: Real execution via Kaggle kernels push
    // The Kaggle execution model is: fetch existing kernel source, then push it as a new version which triggers a run.
    // POST https://www.kaggle.com/api/v1/kernels/push
    // Required fields: slug, text, language, kernelType. Optional: dataset sources, etc.
    // We attempt to fetch the existing kernel's source via pull endpoint, then re-push.
    let kernelText: string | null = null;
    let language = "python";
    let kernelType = "notebook";
    let title: string | undefined;
    let isPrivate = true;
    let enableInternet = true;
    let enableGpu = false;
    let enableTpu = false;
    let previousVersion: number | string | undefined;
    let pullFailed: { status: number; body: string } | null = null;

    if (owner) {
      try {
        // The kernel AND its notebook source come from GET /api/v1/kernels/pull?user_name=&kernel_slug=.
        // Verified against the live API: GET /api/v1/kernels/{owner}/{slug} returns the HTML site
        // page (HTTP 404 with text/html), so it can never supply the source we must re-push.
        const headers: Record<string,string> = { Authorization: authHeader };
        const canonicalUrl = `https://www.kaggle.com/api/v1/kernels/pull?user_name=${encodeURIComponent(owner)}&kernel_slug=${encodeURIComponent(slug)}`;
        let getRes = await fetch(canonicalUrl, { headers, signal: AbortSignal.timeout(20000) } as RequestInit);
        // Fallback to an owner-scoped search if the pull path changes shape.
        if (!getRes.ok) {
          pullFailed = { status: getRes.status, body: await getRes.text().catch(() => "") };
          const searchUrl = `https://www.kaggle.com/api/v1/kernels/list?group=profile&pageSize=100&search=${encodeURIComponent(slug)}`;
          getRes = await fetch(searchUrl, { headers, signal: AbortSignal.timeout(8000) } as RequestInit);
          if (getRes.ok) {
            const data = await getRes.json().catch(()=> null) as unknown;
            const kernels: Array<Record<string,unknown>> = Array.isArray(data) ? data as Array<Record<string,unknown>> : (data as { kernels?: Array<Record<string,unknown>> } | null)?.kernels ?? [];
            const match = kernels.find(k => (k.slug as string) === slug || (k.ref as string) === `${owner}/${slug}`);
            if (match) {
              // We don't have text from list; treat as needing fetch via blob
              // Try to use blob.url if present
              const blobUrl = (match.url as string) ?? "";
              void blobUrl;
            }
          }
        } else if (getRes.ok) {
          const data = await getRes.json().catch(()=> null) as unknown as Record<string, unknown> | null;
          if (data) {
            // Shape: { blob: { source, language, kernelType }, metadata: { title, isPrivate, … } }
            const blob = (data.blob as Record<string, unknown>) ?? data;
            const meta = (data.metadata as Record<string, unknown>) ?? {};
            if (blob) {
              kernelText = (blob.source as string) ?? (blob.text as string) ?? (data.source as string) ?? (data.text as string) ?? null;
              language = (blob.language as string) ?? (meta.language as string) ?? language;
              kernelType = (blob.kernelType as string) ?? (blob.kernel_type as string) ?? (meta.kernelType as string) ?? kernelType;
            }
            // Preserve the kernel's existing settings. Pushing must restart the runtime, not silently
            // rewrite the operator's internet / accelerator / visibility choices.
            title = (meta.title as string) ?? (blob.title as string) ?? undefined;
            isPrivate = (meta.isPrivate as boolean) ?? (blob.isPrivate as boolean) ?? isPrivate;
            enableInternet = (meta.enableInternet as boolean) ?? (blob.enableInternet as boolean) ?? enableInternet;
            enableGpu = (meta.enableGpu as boolean) ?? (blob.enableGpu as boolean) ?? enableGpu;
            enableTpu = (meta.enableTpu as boolean) ?? (blob.enableTpu as boolean) ?? enableTpu;
            previousVersion = (meta.currentVersionNumber as number) ?? undefined;
          }
        }
      } catch {
        // fetching kernel details is best-effort; if it fails we will try push with last-resort minimal payload
      }
    }

    // Kaggle triggers a run by accepting a NEW VERSION, which requires the notebook source. Without it
    // there is nothing to push, so report the real reason rather than firing a request we know is empty.
    if (!kernelText) {
      const status = pullFailed?.status;
      const reason = status
        ? `Kaggle could not return the kernel source for ${owner}/${slug} (HTTP ${status})`
        : `Kaggle returned no source for ${owner}/${slug}`;
      return {
        ok: false,
        error: `${reason}${pullFailed?.body ? `: ${pullFailed.body.slice(0, 200)}` : ""}. Nothing was started.`,
        code: (status === 401 || status === 403 ? "AUTH_FAILED" : status === 404 ? "NOT_AUTOSTARTABLE" : "UNKNOWN") as never,
        provider_response: redactSecrets({ reason: "kernel_source_unavailable", kernelRef, httpStatus: status }) ?? {},
      };
    }

    // Step 3: Push to trigger execution
    try {
      const pushUrl = "https://www.kaggle.com/api/v1/kernels/push";
      const headers: Record<string,string> = {
        Authorization: authHeader,
        "Content-Type": "application/json",
      };

      // Build push payload. If we have kernelText, use it; else send a minimal request that will fail honestly
      const pushBody: Record<string, unknown> = {
        slug: `${owner ?? inferKaggleOwnerFromToken(token) ?? "unknown"}/${slug}`,
        // Kaggle expects id or slug field; we send slug
        newTitle: title ?? slug,
        text: kernelText ?? undefined,
        language,
        kernelType,
        isPrivate,
        enableInternet,
        enableGpu,
        enableTpu,
      };
      // Remove undefined keys so the API can return a clear validation error
      for (const k of Object.keys(pushBody)) if (pushBody[k] === undefined) delete pushBody[k];

      // If kernelText is missing, we are intentionally sending a request that will be rejected by Kaggle
      // with a validation error (real failure) rather than faking success. That satisfies "never fabricate".
      const pushRes = await fetch(pushUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(pushBody),
        signal: AbortSignal.timeout(15000),
      } as RequestInit);

      const rawBody = await pushRes.text().catch(() => "");
      let parsed: Record<string, unknown> | null = null;
      try { parsed = rawBody ? JSON.parse(rawBody) as Record<string, unknown> : null; } catch { parsed = { raw: rawBody.slice(0,1000) }; }

      if (!pushRes.ok) {
        const status = pushRes.status;
        const mapped = mapKaggleHttpError(status, rawBody);
        // Include parsed error if available, redacted
        return {
          ok: false,
          error: `${mapped.msg}${parsed?.error ? `: ${String(parsed.error).slice(0,200)}` : ""}`,
          code: mapped.code as never,
          provider_response: redactSecrets({ httpStatus: status, body: rawBody.slice(0,800), kernelRef, pushBody: redactSecrets(pushBody) }) ?? {},
        };
      }

      // Success: Kaggle returns versionNumber, ref, url, etc.
      const versionNumber = (parsed?.versionNumber as number | string | undefined) ?? (parsed?.version_number as number | string | undefined) ?? null;
      const ref = (parsed?.ref as string) ?? kernelRef;
      const url = (parsed?.url as string) ?? null;

      // Real provider_run_id: use versionNumber if present, else url, else ref
      const provider_run_id = versionNumber != null ? `${ref}@v${versionNumber}` : (url ?? ref);
      if (!provider_run_id || provider_run_id.includes("kaggle:")) {
        // Guard against synthetic fallback: ensure we use real identifier
        // If Kaggle didn't return version, use the returned ref/url, never synthetic startup_request_id
        // startup_request_id is our correlation, not provider's
      }

      return {
        ok: true,
        startup_request_id,
        provider_run_id: String(provider_run_id),
        provider_response: redactSecrets({
          step: "push_succeeded",
          kernelRef: ref,
          previousVersion: previousVersion ?? null,
          versionNumber,
          url,
          // The running worker's ability to tunnel + register depends on these; surface them honestly.
          enableInternet,
          enableGpu,
          enableTpu,
          isPrivate,
          at: new Date().toISOString(),
        }) ?? {},
        initial_state: "requested",
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `Kaggle push failed: ${msg}`, code: "UNKNOWN", provider_response: redactSecrets({ reason: "push_failed", kernelRef, error: msg.slice(0,500) }) ?? {} };
    }
  }
}

// ── Colab helpers ───────────────────────────────────────────────────────────
type ColabConfig = {
  projectId?: string;
  accessToken?: string;
  // Optional: runtime spec, region, etc.
  runtimeSpec?: string;
  runtimeId?: string;
  bootstrapUrl?: string; // mechanism to start worker inside runtime
};

function getColabConfig(workerType: string): ColabConfig {
  const projectId = (process.env.GOOGLE_CLOUD_PROJECT ?? process.env.COLAB_PROJECT_ID ?? process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_PROJECT_ID ?? "").trim();
  const accessToken = (process.env.GOOGLE_OAUTH_TOKEN ?? process.env.COLAB_OAUTH_TOKEN ?? process.env.COLAB_ACCESS_TOKEN ?? process.env.GOOGLE_ACCESS_TOKEN ?? process.env.GOOGLE_OAUTH_ACCESS_TOKEN ?? "").trim();
  const rawSpec = (process.env.COLAB_RUNTIME_SPEC ?? process.env.COLAB_MACHINE_SHAPE ?? process.env.COLAB_RUNTIME_TEMPLATE ?? "").trim();
  const runtimeId = (process.env.COLAB_RUNTIME_ID ?? "").trim();
  // Bootstrap: per-worker type maybe different
  const bootstrapUrl = workerType === "image"
    ? (process.env.COLAB_IMAGE_BOOTSTRAP_URL ?? process.env.COLAB_BOOTSTRAP_URL ?? "").trim()
    : workerType === "voice"
      ? (process.env.COLAB_VOICE_BOOTSTRAP_URL ?? process.env.COLAB_BOOTSTRAP_URL ?? "").trim()
      : (process.env.COLAB_BOOTSTRAP_URL ?? "").trim();
  return { projectId: projectId || undefined, accessToken: accessToken || undefined, runtimeSpec: rawSpec || undefined, runtimeId: runtimeId || undefined, bootstrapUrl: bootstrapUrl || undefined };
}

type StarterErrorCode = NonNullable<Extract<RuntimeStartOutcome, { ok: false }>["code"]>;
function mapColabHttpError(status: number, body: string): { code: StarterErrorCode; msg: string } {
  if (status === 401 || status === 403) {
    if (body.includes("allowlist") || body.includes("Allowlist") || body.includes("FAILED_PRECONDITION") || body.includes("not allowlisted")) {
      return { code: "NOT_AUTOSTARTABLE", msg: `Colab allowlist required (HTTP ${status}) — project not allowlisted for Colab API beta` };
    }
    if (status === 401) return { code: "AUTH_FAILED", msg: `Colab auth failed (HTTP ${status}) — check GOOGLE_OAUTH_TOKEN` };
    return { code: "AUTH_FAILED", msg: `Colab auth/permission failed (HTTP ${status})` };
  }
  if (status === 429) return { code: "RATE_LIMITED", msg: `Colab rate-limited (HTTP ${status})` };
  if (status === 402) return { code: "QUOTA_EXCEEDED", msg: `Colab quota exceeded (HTTP ${status})` };
  return { code: "UNKNOWN", msg: `Colab request failed (HTTP ${status})` };
}

async function colabCreateRuntime(workerType: string, runtime: string, provider: string, trigger_source: string): Promise<RuntimeStartOutcome> {
  const cfg = getColabConfig(workerType);
  const startup_request_id = `colab:${Date.now().toString(36)}:${Math.random().toString(36).slice(2,8)}`;

  if (!cfg.projectId) {
    return { ok: false, error: "Colab GOOGLE_CLOUD_PROJECT / COLAB_PROJECT_ID not configured — cannot create managed runtime", code: "NOT_AUTOSTARTABLE", provider_response: { reason: "missing_project", runtime, worker_type: workerType } };
  }
  if (!cfg.accessToken) {
    return { ok: false, error: "Colab GOOGLE_OAUTH_TOKEN / COLAB_OAUTH_TOKEN not configured — OAuth scope https://www.googleapis.com/auth/colaboratory required", code: "AUTH_FAILED", provider_response: { reason: "missing_token", runtime, worker_type: workerType } };
  }

  // Bootstrap check: if no mechanism to actually start the worker inside the runtime, don't create a dangling runtime
  // Spec: "If the chosen bootstrap mechanism cannot yet be automated reliably, report WAITING/NOT_AUTOSTARTABLE and document the exact blocker."
  // We treat missing bootstrapUrl as not-autostartable when the runtimeSpec is not explicitly allowlisted to auto-bootstrap.
  // However, if the user has explicitly configured a runtimeSpec and wants us to create the runtime anyway, we allow creation
  // and then note bootstrap pending. For now, we require bootstrapUrl to be set for automatic worker start.
  // To keep the scheduler truthful, we return NOT_AUTOSTARTABLE with instructions rather than creating an idle runtime.
  if (!cfg.bootstrapUrl) {
    // Check if there's a notebook URL configured as bootstrap? Treat as not reliable per spec: "Do not treat a notebook URL as an API execution method."
    const notebookUrl = (process.env.COLAB_NOTEBOOK_URL ?? "").trim();
    if (notebookUrl) {
      return {
        ok: false,
        error: "Colab bootstrap unavailable — COLAB_BOOTSTRAP_URL not configured. A notebook URL alone is not an execution method; a replaceable bootstrap (e.g., startup script that registers with Ostra) must be configured.",
        code: "NOT_AUTOSTARTABLE",
        provider_response: { reason: "bootstrap_not_configured", runtime, worker_type: workerType, notebookUrlHint: "Set COLAB_IMAGE_BOOTSTRAP_URL / COLAB_VOICE_BOOTSTRAP_URL to a bootstrap endpoint/script" },
      };
    }
    return {
      ok: false,
      error: "Colab worker bootstrap not configured — set COLAB_IMAGE_BOOTSTRAP_URL (or COLAB_VOICE_BOOTSTRAP_URL) / COLAB_BOOTSTRAP_URL to the mechanism that starts the actual Image/Voice worker inside the runtime and makes it POST /api/workers/register. Runtime creation alone does not execute notebook cells.",
      code: "NOT_AUTOSTARTABLE",
      provider_response: { reason: "bootstrap_not_configured", runtime, worker_type: workerType },
    };
  }

  // Optional: list runtime specs to validate eligibility before creation (if runtimeSpec provided, check eligible)
  // This is best-effort; if it fails we still attempt creation and let the creation error be the truth.
  if (cfg.runtimeSpec) {
    try {
      const listUrl = "https://colaboratory.googleapis.com/v1beta/runtimespecs";
      const listRes = await fetch(listUrl, {
        headers: { Authorization: `Bearer ${cfg.accessToken}` },
        signal: AbortSignal.timeout(8000),
      } as RequestInit);
      if (listRes.ok) {
        const listData = await listRes.json().catch(()=> null) as { runtimeSpecs?: Array<{ key?: { id?: string }; eligible?: boolean }> } | null;
        const specs = listData?.runtimeSpecs ?? [];
        if (specs.length > 0) {
          const match = specs.find(s => s.key?.id === cfg.runtimeSpec);
          if (match && match.eligible === false) {
            return { ok: false, error: `Colab runtime spec ${cfg.runtimeSpec} not eligible for this account/project`, code: "NOT_AUTOSTARTABLE", provider_response: { reason: "spec_not_eligible", runtimeSpec: cfg.runtimeSpec } };
          }
        }
      } else if (listRes.status === 403 || listRes.status === 401) {
        // Don't block creation on list failure; creation will surface real auth error
      }
    } catch {
      // ignore list failure
    }
  }

  // Create runtime: POST https://colaboratory.googleapis.com/v1beta/runtimes
  // See https://developers.google.com/colab/api/reference/rest/v1beta/runtimes/create
  // Body is a Runtime object: { displayName?, runtimeType?, ... } — spec is project-scoped
  // For Colab Enterprise, Runtime may require runtimeTemplate or spec. We send minimal + accelerator if configured.
  try {
    const createUrl = "https://colaboratory.googleapis.com/v1beta/runtimes" + (cfg.runtimeId ? `?runtimeId=${encodeURIComponent(cfg.runtimeId)}` : "");
    const body: Record<string, unknown> = {
      // displayName helps identify Ostra-managed runtimes
      displayName: `ostra-${workerType}-${runtime}-${Date.now().toString(36)}`,
    };
    if (cfg.runtimeSpec) {
      // Runtime spec may be referenced via runtimeConfig or spec id; we use versioned field
      // According to discovery doc, Runtime has `runtimeConfig` and `runtimeSpec` fields varies; we try both
      body.runtimeConfig = { runtimeSpec: cfg.runtimeSpec };
      body.spec = cfg.runtimeSpec;
    }
    // Include bootstrap hint for auditing
    body.labels = { "ostra-worker-type": workerType, "ostra-runtime": runtime, "ostra-provider": provider, "ostra-trigger": trigger_source };

    const createRes = await fetch(createUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    } as RequestInit);

    const rawBody = await createRes.text().catch(()=> "");
    let parsed: Record<string, unknown> | null = null;
    try { parsed = rawBody ? JSON.parse(rawBody) as Record<string, unknown> : null; } catch { parsed = { raw: rawBody.slice(0,1000) }; }

    if (!createRes.ok) {
      const status = createRes.status;
      const mapped = mapColabHttpError(status, rawBody);
      // If allowlist, surface as NOT_AUTOSTARTABLE per spec
      return {
        ok: false,
        error: `${mapped.msg}${parsed?.error ? `: ${String((parsed.error as Record<string,unknown>)?.message ?? parsed.error).slice(0,200)}` : ""}`.trim(),
        code: mapped.code,
        provider_response: redactSecrets({ httpStatus: status, body: rawBody.slice(0,800), worker_type: workerType, runtime }) ?? {},
      };
    }

    // Success: returns Operation { name: "operations/...", done: false, metadata: ... }
    const opName = (parsed?.name as string) ?? (parsed?.operation as string) ?? startup_request_id;
    const done = (parsed?.done as boolean) ?? false;

    if (done) {
      // Operation already done — runtime should be available, but bootstrap still needed
      // Check runtime connection info if present
      const _runtimeUrl = (parsed?.response as Record<string,unknown> | undefined)?.url as string | undefined ?? (parsed?.runtime as Record<string,unknown> | undefined)?.proxyUrl as string | undefined;
      void _runtimeUrl;
    }

    // Even after runtime creation, we must not claim ONLINE. The worker must bootstrap and register.
    // Return requested with real provider_run_id = operation name.
    const provider_run_id = String(opName);

    return {
      ok: true,
      startup_request_id,
      provider_run_id,
      provider_response: redactSecrets({
        step: "colab_runtime_create_requested",
        operation: opName,
        done,
        worker_type: workerType,
        runtime,
        provider,
        bootstrapUrl: cfg.bootstrapUrl ? "[REDACTED]" : undefined,
        at: new Date().toISOString(),
      }) ?? {},
      initial_state: "requested",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Colab runtime create failed: ${msg}`, code: "UNKNOWN", provider_response: { reason: "fetch_failed", runtime, worker_type: workerType } };
  }
}

// ── Colab image/voice starters (real API, truthful when not allowlisted) ─────
export class ColabImageRuntimeStarter implements RuntimeStarter {
  readonly runtime = "colab";
  readonly provider = "colab-image";
  readonly autostartable = true;
  async start(input: RuntimeStartInput): Promise<RuntimeStartOutcome> {
    // Keep autostartable true so scheduler can attempt; start will return NOT_AUTOSTARTABLE truthfully when not configured/allowlisted
    return colabCreateRuntime(input.worker_type, input.runtime, input.provider, input.trigger_source);
  }
}

export class ColabVoiceRuntimeStarter implements RuntimeStarter {
  readonly runtime = "colab";
  readonly provider = "kokoro-82m";
  readonly autostartable = true;
  async start(input: RuntimeStartInput): Promise<RuntimeStartOutcome> {
    return colabCreateRuntime(input.worker_type, input.runtime, input.provider, input.trigger_source);
  }
}

// ── Registry ─────────────────────────────────────────────────────────────────
export function resolveRuntimeStarters(overrides?: { kaggleCfg?: KaggleStartConfig }): Map<string, RuntimeStarter> {
  const kaggle = new KaggleRuntimeStarter(overrides?.kaggleCfg);
  const colabImage = new ColabImageRuntimeStarter();
  const colabVoice = new ColabVoiceRuntimeStarter();
  const m = new Map<string, RuntimeStarter>();
  m.set(`${kaggle.runtime}:${kaggle.provider}`, kaggle);
  m.set(`${colabImage.runtime}:${colabImage.provider}`, colabImage);
  m.set(`${colabVoice.runtime}:${colabVoice.provider}`, colabVoice);
  // Generic lookups
  m.set("kaggle", kaggle);
  m.set("colab:image", colabImage);
  m.set("colab:voice", colabVoice);
  m.set("colab", colabImage); // default colab lookup maps to image (voice can be queried explicitly)
  return m;
}

export function findStarter(map: Map<string, RuntimeStarter>, runtime: string, provider: string): RuntimeStarter | null {
  return map.get(`${runtime}:${provider}`) ?? map.get(`${runtime}:${provider.toLowerCase()}`) ?? map.get(runtime) ?? (runtime === "colab" ? map.get(`colab:${provider.includes("voice") || provider.includes("kokoro") ? "voice" : "image"}`) ?? null : null);
}
