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

## Management — `/management`

The director's room with the **Management Team**, a hosted OpenAI-compatible model the backend calls
(`MANAGER_API_KEY` + `MANAGER_BASE_URL` on Render — see `docs/API_ENV.md`). No secret is ever needed in
Vercel: the browser only talks to this backend, which holds the key.

```
GET  {NEXT_PUBLIC_API_URL}/api/agents/management          → what the management team may do right now
POST {NEXT_PUBLIC_API_URL}/api/agents/rooms/:id/manage    → one turn: brief + instructions + starts
POST {NEXT_PUBLIC_API_URL}/api/agents/rooms/:id/dispatch   → manager speaks first, then Script → Image → Voice → Showrunner
```

| Backend answer | Page shows |
| --- | --- |
| No key configured | `autonomy` chip, `Model: not configured`, and the exact reason from the API |
| Key set, model answered | the model id + host of the hosted endpoint |
| Key set, model unreachable | the same host and the real failure reason — never a fake ONLINE |
| `MANAGER_AUTONOMY=off` | chip reads `may talk, may not act on runtimes`; a refused start is listed with its reason |
| `startable[].ok === false` | `start <target>: refused` with the tooltip explaining why (a slot with no start path, or an agent whose own `KAGGLE_KERNEL_REF_<SLOT>` is unset) |

The channel list on the page is the real `agent_messages` rows — instructions the management team sent to
the agents appear there as `instruction`, exactly as they were stored.

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
| Script AI · Qwen3 4B | `script` | `kaggle` | `kaggle` | enabled — re-pushes `KAGGLE_KERNEL_REF` as a new version |
| Image AI · Qwen3 4B | `image` | `kaggle` | `kaggle` | enabled — re-pushes `KAGGLE_KERNEL_REF_IMAGE`; `409` naming that variable while it is unset |
| Voice AI · Qwen3 4B | `voice` | `kaggle` | `kaggle` | enabled — re-pushes `KAGGLE_KERNEL_REF_VOICE` |
| Showrunner · Qwen3 4B | `overseer` | `kaggle` | `kaggle` | enabled — re-pushes `KAGGLE_KERNEL_REF_OVERSEER` |
| Video Engine · FFmpeg | `video` | `local` | `ffmpeg` | disabled — not deployed yet |
| YouTube Publisher | `youtube` | `api` | `youtube-api` | disabled — YouTube OAuth is not configured |

`runtime` / `provider` here are the planned home of the slot. The health shown beside each button is
the live worker row, so an agent that registered on Kaggle is reported as Kaggle with the model it
actually loaded.

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

Never place `KAGGLE_API_TOKEN`, `KAGGLE_KERNEL_REF`, `KAGGLE_KERNEL_REF_<SLOT>`, `SUPABASE_SERVICE_ROLE_KEY`
or any other secret in Vercel. Each Kaggle button runs ITS OWN notebook, chosen on **Render** by
`KAGGLE_KERNEL_REF` (Script AI) or `KAGGLE_KERNEL_REF_<SLOT>` (Image / Voice / Showrunner). A missing
per-slot ref is refused by name, never replaced with another agent's notebook.
