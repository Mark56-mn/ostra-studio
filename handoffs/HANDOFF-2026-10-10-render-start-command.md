# Handover — Render deploy fails: start command is `Yarn start` (exit 127)

Date: 2026-10-10
Branch: `main` at `41975e6` (the commit Render checked out)

## 1. Task

The user pasted Render deploy logs: the build succeeds, then `==> Running 'Yarn start'` →
`bash: line 1: Yarn: command not found` → `Exited with status 127`.

## 2. Result

Diagnosed; **the failure is a Render dashboard setting, not a repository defect.** No code change was
needed or made.

- The service's **Start Command** is literally `Yarn start` (capital `Y`). No such binary exists on
  Render's image, so bash exits 127 before any project code runs.
- Even lowercase `yarn start` would not work: this deploy's image is Bun-based
  (`Using Bun version 1.4.2 (default)`), and yarn is not on `PATH`.
- The build step is fine (`bun install`, 452 installs, no changes) and the commit is correct.

**The fix (Render → Service → Settings → Start Command):**

```
bun start
```

Verified from the repo root in this workspace (2026-10-10):
`PORT=3999 timeout 20 bun start` → `bun --filter @ostra/api start` →
`[ostra-api] listening on 0.0.0.0:3999  autoPublish=false  supabase=not_configured` (the API boots;
the SIGTERM was the test's own 20-second bound). The chain is root `start` → `bun --filter @ostra/api
start` → `node --import tsx src/index.ts`.

## 3. Repository state

`main` at `41975e6`, deployed to Render. Nothing structural changed.

## 4. Files changed

- `README.md` — the deploy block now records the required Render Start Command and why `Yarn start`
  fails (same place the 2026-10-08 `bun --filter … run build` failure is already documented).

## 5. Tests/checks

- `bun test` → 456 pass / 0 fail (unchanged this pass; no source touched).
- Bounded start smoke test as above — real boot, real log line.

## 6. Integration status

- **Render** — build stage verified from the pasted logs (build successful); start stage fails on the
  dashboard command. Not re-deployed from here.
- **Supabase** — schema current (20 tables incl. `seasons`, `notifications`), applied and verified
  2026-10-09.

## 7. Known issues

- After the Start Command is fixed and the service restarts, the NEW routes (`/api/seasons`,
  `/api/notifications`, `/api/media/*`) go live for the first time. They have not been exercised
  against a deployed instance.
- `scripts/smoke-seasons.ts` (the season-gate acceptance test) still needs `SUPABASE_URL` +
  `SUPABASE_SERVICE_ROLE_KEY` on whatever host runs it.

## 8. Decisions

- **No `render.yaml` added.** A Blueprint file only takes effect when the user hits "Sync", and a name
  mismatch with the existing service would create a DUPLICATE service. The one-field dashboard change
  is safer and permanent. (The service name is not readable from this workspace.)

## 9. Environment/configuration

- Render Start Command: `bun start`. Build Command can stay `bun install`. Node `>=20.6.0` (image ran
  26.11.1 — fine).

## 10. Next agent

If the deploy still fails after the Start Command is set to `bun start`, read the live logs with
`freebuff-deploy logs` / Render's Events tab and check `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
are present in the service environment — the API logs `supabase=not_configured` at boot when they are
missing, and every DB route then answers 503.

## 11. Do not redo

- Do not re-diagnose the `Yarn: command not found` line — it is the dashboard field, not the code.
- Do not add a `render.yaml` to "fix" it (see §8).

## 12. Verification

Unverified: a successful Render boot after the setting change (only the user can change the setting);
the new routes against a deployed backend.
