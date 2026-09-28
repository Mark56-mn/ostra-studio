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
