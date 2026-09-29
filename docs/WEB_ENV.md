# Web (Vercel) env — `apps/web`

Only `NEXT_PUBLIC_*` is browser-visible. Never put secrets here.

```
NEXT_PUBLIC_API_URL=https://ostra-studio-1.onrender.com   # Production (and Preview)
NEXT_PUBLIC_APP_NAME=Ostra Studio
```

Rules:

- `NEXT_PUBLIC_API_URL` **must** be set for the **Production** environment. It is the only backend the
  dashboard talks to.
- Never add `KAGGLE_API_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`, `WORKER_REGISTRATION_TOKEN` or any other
  secret to Vercel. The browser must never receive them.
- The frontend joins paths exactly once: `apiUrl("/api/health")` →
  `https://ostra-studio-1.onrender.com/api/health` (no `/api/api/...`, no dropped `/api`).

What the UI shows (all from `GET /api/health` + `GET /api/workers`, never hard-coded):

| Condition | Displayed |
| --- | --- |
| `NEXT_PUBLIC_API_URL` missing | `RENDER API · NOT_CONFIGURED` (with the exact env name) |
| API unreachable / non-JSON | `BACKEND OFFLINE — Unable to reach Render API` + connection error |
| API reachable, Supabase unwired | Supabase row `NOT_CONFIGURED`, backend status `DEGRADED` |
| Provider configured but idle | `OFFLINE` (or `STARTING` while a start is in flight) |
| Provider missing credentials | `NOT_CONFIGURED` + the missing key names |
| Provider/startup failed | `ERROR` + `errorCode`/reason |
| Worker registered + fresh heartbeat | `ONLINE` with heartbeat age |

Leave `NEXT_PUBLIC_API_URL` empty only for local dev — the Next `/api/health` shim then reports
`DEGRADED` + `Backend not configured (NEXT_PUBLIC_API_URL missing)`. It never invents provider states.

## Runner — `/runner` (one button per AI)

`/runner` renders one run button per entry in `MODEL_CATALOG` (`packages/shared/src/providers/models.ts`).
A press calls exactly one endpoint — there is no runner-specific API and no local simulation:

```
POST {NEXT_PUBLIC_API_URL}/api/runtime/run-now
  { "worker_type": "<providerId>", "runtime": "<runtime>", "provider": "<provider>" }
GET  {NEXT_PUBLIC_API_URL}/api/runtime/history?limit=40
```

| Entry | worker_type | runtime | provider | Button |
| --- | --- | --- | --- | --- |
| Script AI · Qwen3 1.7B | `script` | `kaggle` | `kaggle` | enabled — re-pushes the notebook as a new version |
| Image AI · Colab | `image` | `colab` | `colab-image` | enabled — answers `NOT_AUTOSTARTABLE` until Colab creds exist |
| Voice AI · Kokoro-82M | `voice` | `colab` | `kokoro-82m` | enabled — same rule as Image |
| Video Engine · FFmpeg | `video` | `local` | `ffmpeg` | disabled — no starter exists for `local` |
| YouTube Publisher | `youtube` | `api` | `youtube-api` | disabled — no starter exists for `api` |

Displayed states are read, never assumed:

| API answer | UI shows |
| --- | --- |
| `201 {action:"requested"}` | `START REQUESTED` (sky) + "not ONLINE until a worker registers and heartbeats" |
| `200 {action:"skipped_already_online"}` | `ALREADY ONLINE` (emerald) — no duplicate start |
| `200 {action:"skipped_disabled"}` | `SWITCHED OFF` (amber) — button is disabled while the switch is off |
| `200 {action:"skipped_cooldown" \| "skipped_in_progress"}` | amber, with the recorded reason |
| `409 {action:"not_autostartable"}` | `NOT AUTOSTARTABLE` (muted) |
| `400 {action:"failed"}` / no `action` | red, with the real error text (HTTP status included) |

The lifecycle pill (`RUN REQUESTED / STARTING / REGISTERING / ONLINE / FAILED / TIMEOUT / CANCELLED`) comes
from the persisted `runtime_startup_history` row for that `worker_type`+`runtime`, refreshed every 12s.
`/api/models` is read best-effort for the switch + real health; when it is missing (an API build that
predates it) the Runner says `SWITCH / HEALTH UNKNOWN` and keeps the buttons working, because the
orchestrator — not the browser — enforces the switches.

Never place `KAGGLE_API_TOKEN`, `KAGGLE_KERNEL_REF`, `SUPABASE_SERVICE_ROLE_KEY` or any other secret in
Vercel. The notebook the Kaggle button runs is chosen by `KAGGLE_KERNEL_REF` on **Render**.
