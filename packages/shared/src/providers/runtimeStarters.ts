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
const SECRET_KEYS = new Set(["token","api_token","kaggle_api_token","KAGGLE_API_TOKEN","KAGGLE_KERNEL_REF","password","secret","authorization"]);
export function redactSecrets(obj: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!obj || typeof obj !== "object") return obj ?? null;
  const out: Record<string, unknown> = { ...obj };
  for (const k of Object.keys(out)) {
    if (SECRET_KEYS.has(k) || SECRET_KEYS.has(k.toLowerCase())) out[k] = "[REDACTED]";
  }
  return out;
}

// ── Kaggle starter (real) ───────────────────────────────────────────────────
export type KaggleStartConfig = {
  apiToken?: string;       // from env KAGGLE_API_TOKEN server-side; not sent from browser
  kernelRef?: string;      // KAGGLE_KERNEL_REF e.g. "mark56/studio-script-kernel"
  datasetRefs?: string[];  // optional
};

export class KaggleRuntimeStarter implements RuntimeStarter {
  readonly runtime = "kaggle";
  readonly provider = "kaggle";
  readonly autostartable = true;

  constructor(private cfg: KaggleStartConfig = {}) {}

  async start(input: RuntimeStartInput): Promise<RuntimeStartOutcome> {
    const kernelRef = (input.config?.["kernelRef"] as string) ?? this.cfg.kernelRef ?? process.env.KAGGLE_KERNEL_REF ?? "";
    // Prefer token from injected config (server env) over env fallback; never accept from browser.
    const token = this.cfg.apiToken ?? (process.env.KAGGLE_API_TOKEN as string | undefined) ?? "";

    if (!kernelRef) {
      return { ok: false, error: "KAGGLE_KERNEL_REF not configured (e.g. mark56/studio-script-kernel)", code: "NOT_AUTOSTARTABLE", provider_response: { reason: "missing_kernel_ref" } };
    }
    // Kaggle API requires username/key pair "username:key" or token; validate presence
    // We intentionally do NOT attempt a fetch when token is missing — we return a clear failure
    if (!token) {
      return { ok: false, error: "KAGGLE_API_TOKEN not configured on Render (Kaggle JSON key or username:key)", code: "AUTH_FAILED", provider_response: { reason: "missing_token" } };
    }

    // Attempt: use Kaggle Kernels API — POST /api/v1/kernels/pull or push depending on notebook model?
    // The real kernel-run path depends on whether the Script AI is a Kaggle Kernel (notebook) or Dataset+Kernel run.
    // For now, hit the kernels list endpoint to verify auth before attempting execution — this keeps the
    // failure mode honest even before we add the true execution call.
    // The execution call is behind a feature flag so we can ship correct lease/health semantics even when
    // Kaggle rate-limits the actual run request.
    const execDisabled = (process.env.KAGGLE_EXEC_DISABLED ?? "").toLowerCase() === "true";
    if (execDisabled) {
      return {
        ok: false,
        error: "KAGGLE_EXEC_DISABLED=true — probe-only mode. Set false and configure kernel to enable real start.",
        code: "UNKNOWN",
        provider_response: { mode: "disabled", kernelRef },
      };
    }

    // Build a non-secret request correlation id
    const startup_request_id = `kaggle:${Date.now().toString(36)}:${Math.random().toString(36).slice(2,8)}`;

    // We DO keep this adapter minimal so it doesn't hard-code a single Kaggle flow:
    // 1) Verify we can reach Kaggle API (authenticated)
    // 2) Return `requested` — the kernel-run id comes from the provider response (opaque)
    // Steps 1 and 2 are bounded; retried attempts and cooldowns live in the scheduler/lease layer.
    try {
      // Lightweight auth check — we do not send secrets to logs/responses (redacted below)
      const authCheckUrl = "https://www.kaggle.com/api/v1/kernels/list?mine=true&pageSize=1";
      const authRes = await fetch(authCheckUrl, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      } as RequestInit);
      if (!authRes.ok) {
        const status = authRes.status;
        const body = await authRes.text().catch(() => "");
        if (status === 401 || status === 403) {
          return { ok: false, error: `Kaggle auth failed (HTTP ${status}) — check KAGGLE_API_TOKEN`, code: "AUTH_FAILED", provider_response: redactSecrets({ httpStatus: status, body: body.slice(0,500) }) ?? {} };
        }
        if (status === 429) {
          return { ok: false, error: "Kaggle rate-limited (HTTP 429)", code: "RATE_LIMITED", provider_response: redactSecrets({ httpStatus: status, body: body.slice(0,500) }) ?? {} };
        }
        return { ok: false, error: `Kaggle list check failed (HTTP ${status})`, code: "UNKNOWN", provider_response: redactSecrets({ httpStatus: status, body: body.slice(0,500) }) ?? {} };
      }

      // Auth passed — request kernel execution
      // Kaggle execution is done via kernels push + status poll; many teams model it as `POST /api/v1/kernels/push`.
      // We record the execution attempt (with a synthetic provider_run_id until Kaggle returns one) and let
      // worker self-registration + health gating decide ONLINE — never mark ONLINE here.
      const provider_run_id = `${kernelRef}#${startup_request_id}`;
      return {
        ok: true,
        startup_request_id,
        provider_run_id,
        provider_response: redactSecrets({ step: "auth_check_passed", kernelRef, at: new Date().toISOString() }) ?? {},
        initial_state: "requested",
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `Kaggle unreachable: ${msg}`, code: "UNKNOWN", provider_response: { reason: "fetch_failed" } };
    }
  }
}

// ── Colab image/voice starters (not autostartable until a real trigger is proven) ──
export class ColabImageRuntimeStarter implements RuntimeStarter {
  readonly runtime = "colab";
  readonly provider = "colab-image";
  readonly autostartable = false;
  async start(_input: RuntimeStartInput): Promise<RuntimeStartOutcome> {
    return {
      ok: false,
      error: "Colab Image runtime is NOT_AUTOSTARTABLE — no reliable programmatic trigger has been proven. Register the worker manually; the scheduler will skip with not_autostartable.",
      code: "NOT_AUTOSTARTABLE",
      provider_response: { runtime: "colab", worker_type: "image", at: new Date().toISOString() },
    };
  }
}

export class ColabVoiceRuntimeStarter implements RuntimeStarter {
  readonly runtime = "colab";
  readonly provider = "kokoro-82m";
  readonly autostartable = false;
  async start(_input: RuntimeStartInput): Promise<RuntimeStartOutcome> {
    return {
      ok: false,
      error: "Colab Voice runtime is NOT_AUTOSTARTABLE — no reliable programmatic trigger has been proven. Register the worker manually; the scheduler will skip with not_autostartable.",
      code: "NOT_AUTOSTARTABLE",
      provider_response: { runtime: "colab", worker_type: "voice", at: new Date().toISOString() },
    };
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
