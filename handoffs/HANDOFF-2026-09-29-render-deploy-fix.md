# Handoff — Render deployment failure: root-cause + compatibility fix

Date: 2026-09-29
Commit: `978b888` (pushed to `origin/main`)

## 1. Task

User report: **"Render deployment failed check for code errors or comparability issues."**
Find and fix the code/compatibility problem that made the Render deployment of `apps/api` fail.

## 2. Result

Found and fixed one **reproducible, build-breaking incompatibility**:

- Both app `tsconfig.json` files set `"baseUrl": "."`. The current `typescript@latest` on npm is
  **7.0.2** (this project's date is 2026), and TypeScript 7 **removed `baseUrl`**. Reproduced exactly:

  ```
  $ cd apps/api && npx -y -p typescript@7.0.2 tsc --noEmit
  tsconfig.json(16,5): error TS5102: Option 'baseUrl' has been removed. Please remove it from your configuration.
    Use '"paths": {"*": ["./*"]}' instead.
  ```

  Same failure on `apps/web/tsconfig.json` line 22. A Render build that resolves a TypeScript ≥ 7
  (e.g. `npx tsc` with no local install, because devDependencies were omitted) fails the deploy here.

- Fix: removed `baseUrl` from `apps/api/tsconfig.json` and `apps/web/tsconfig.json`. `paths` has
  resolved relative to the config file since TS 4.1, so resolution is unchanged (`@/*` → `./src/*`,
  `@ostra/shared` → `../../packages/shared/src/index.ts`), and it now works on TS 5 **and** TS 7.
- Added `apps/web/src/assets.d.ts` (`declare module "*.css"`) because TS 7 additionally rejects the
  CSS side-effect import in `apps/web/src/app/layout.tsx` with `TS2882`. `apps/web` is Vercel's, but
  the same latent incompatibility is now gone.
- Declared `"engines": { "node": ">=20.6.0" }` in the root and `apps/api` `package.json` — the start
  command `node --import tsx src/index.ts` requires Node ≥ 20.6; there was no version declaration at all.
- Documented the known-good Render build/start config plus a deploy-failure checklist in `docs/API_ENV.md`.

**Honesty caveat (important):** this workspace **cannot read Render's deploy log** — Render is an
external service, `freebuff-deploy status` reports *no deployments* (confirming Render is not
Freebuff-managed), and no Render API credential exists in the environment. The TS5102 error is a
**real, reproduced** build-breaking incompatibility and the most likely cause, **but it is not
confirmed against the actual Render log.** After the fix, `apps/api` builds green under TS 5.9.3 and
TS 7.0.2 and boots with the exact production start command.

## 3. Repository state

- Branch `main`, clean, `HEAD == origin/main == 978b888`.
- Previous HEAD was `4af5f21` (Runner). This commit only touches build/config/docs — no source logic.
- `git status --short --branch` → `## main...origin/main` (clean).

## 4. Files changed

| File | Change |
| --- | --- |
| `apps/api/tsconfig.json` | Removed `"baseUrl": "."` (kept `paths`). |
| `apps/web/tsconfig.json` | Removed `"baseUrl": "."` (kept `paths`). |
| `apps/web/src/assets.d.ts` | **New.** `declare module "*.css"` / `"*.scss"` / `"*.sass"` for TS 7. |
| `package.json` | Added `"engines": { "node": ">=20.6.0" }`. |
| `apps/api/package.json` | Added `"engines": { "node": ">=20.6.0" }`. |
| `docs/API_ENV.md` | New "Render build & start (deploy config)" + "Deploy-failure checklist". |

## 5. Tests/checks

All run from the repo root, real output:

| Command | Result |
| --- | --- |
| `cd apps/api && npx -y -p typescript@7.0.2 tsc --noEmit` (before fix) | **FAIL** — `tsconfig.json(16,5): error TS5102: Option 'baseUrl' has been removed.` |
| `cd apps/api && npx -y -p typescript@7.0.2 tsc --noEmit` (after fix) | exit 0 |
| `cd apps/web && npx -y -p typescript@7.0.2 tsc --noEmit` (after fix) | exit 0 |
| `npm run typecheck` (local TS 5.9.3) | `@ostra/web typecheck: Exited with code 0`, `@ostra/api build: Exited with code 0` |
| `bun test` | **196 pass / 0 fail** across 13 files |
| `bun run lint` | exit 0, only the 4 pre-existing warnings (`react-hooks/exhaustive-deps` ×3, `no-page-custom-font` ×1) |
| `bun install --frozen-lockfile` | exit 0 — "Checked 452 installs across 510 packages (no changes)" → `bun.lock` is in sync |
| API boot (exact Render start command, bounded 10 s): `cd apps/api && PORT=4599 timeout 10 node --import tsx src/index.ts` | Boots; `GET /health` → HTTP 200 (honest `DEGRADED`, Supabase not configured locally); `GET /api/models` → **503** (endpoint exists in new code; the stale Render build serves **404**) |

## 6. Integration status

- **Render** — unavailable from this workspace. Cannot read deploy logs or env, cannot redeploy.
  Live check from the prior session: production API serves a **stale build** (old slug error text;
  `/api/models` → 404). No Render credential in `.env`/`.env.local`.
- **Freebuff-managed hosting** — not applicable: `freebuff-deploy status` → "No deployments yet".
  This confirms the failing deploy is the **external Render service**, not a Freebuff deploy.
- **Supabase** — configured but unverified in this task (not touched; local boot reports
  `SUPABASE_SERVICE_ROLE_KEY` unset, which is expected in the sandbox).
- **Kaggle / Colab / Vercel** — not attempted in this task.

## 7. Known issues

- **The Render deploy log was never seen.** TS5102 is reproduced and plausible but unconfirmed as the
  exact Render error. Ask the operator to paste the Render build/start log to confirm or redirect.
- Secondary compatibility hazards identified but **not changed** (each is a real way a Render build can
  fail; documented in `docs/API_ENV.md` instead of altered, to avoid guessing at dashboard config):
  - The repo ships **only `bun.lock`** (no `package-lock.json`). An `npm ci` install command fails
    outright; `npm install` works but uses a different lockfile.
  - `tsx` (the start loader) is a **devDependency** — an install with `--omit=dev`/`--production`
    makes `node --import tsx` crash at start.
  - `@ostra/shared` is **not declared as a dependency** of `apps/api`. It resolves only because tsx
    reads the API's tsconfig `paths` (`../../packages/shared/src/index.ts`), so the Render **Root
    Directory must be the repo root**, not `apps/api`.
- The Vercel side (`apps/web`) has the same class of latent TS-7 issue; fixed here, unverified on Vercel.

## 8. Decisions

- **Remove `baseUrl` rather than pin TypeScript.** Pinning (`~5.9.3`) would only mask the problem;
  `paths`-without-`baseUrl` is equivalent since TS 4.1, so the tsconfigs become version-agnostic
  (works on TS ≥ 4.1, including 5 and 7).
- **Do not switch the deploy to npm or restructure the workspace** for the speculative install-path
  issues. The lockfile is consistent (`bun install --frozen-lockfile` passes), so the evidence does
  not support rewriting the dependency setup; the hazard is documented for the operator instead.
- **Add `engines.node`** because the `--import` flag hard-requires Node ≥ 20.6 and the repo declared
  no version anywhere. Chosen as a range (`>=20.6.0`) so the currently-working Node 24 stays selected.
- Kept the change set confined to build/config/docs; no runtime source logic was touched.

## 9. Environment/configuration

- Required at build/start on Render: Node ≥ 20.6 (24 verified), `bun install` (uses `bun.lock`),
  build `bun --filter @ostra/api build`, start `bun --filter @ostra/api start`
  (= `node --import tsx src/index.ts`), Root Directory = **repo root**.
- Runtime env (unchanged, set by the operator in the Render dashboard): `SUPABASE_URL` (or
  `SUPABASE_CONNECTION_STRING`), `SUPABASE_SERVICE_ROLE_KEY`, `CORS_ORIGINS`, `CRON_SECRET`,
  `WORKER_REGISTRATION_TOKEN`/`_SECRET`, `SCHEDULER_ENABLED`, `KAGGLE_API_TOKEN`, `KAGGLE_KERNEL_REF`,
  `PORT` (injected by Render).
- Sandbox env keys (names only): `.env` = `DATABASE_URL`, `SUPABASE_CONNECTION_STRING`, `host`, `port`,
  `database`, `user`, `password`, `KAGGLE_API_TOKEN`; `.env.local` = `KAGGLE_KERNEL_REF`.
  No Render credential is present. No secret values are recorded here.
- No migrations involved. Migrations remain 001–004 (004 already applied).

## 10. Next agent

**Ask the operator for the Render build/start log**, then either (a) confirm TS5102 was the failure and
verify the redeploy of `978b888` succeeds — after which `/api/models` must stop returning 404 on
`https://ostra-studio-1.onrender.com` — or (b) read the real error and fix that instead.
Prerequisite: the operator must trigger the Render redeploy (this workspace cannot).

## 11. Do not redo

- Do not re-add `baseUrl` to any tsconfig.
- Do not "fix" the build by pinning TypeScript or by hand-editing `_generated`/lockfiles.
- Do not re-investigate whether `bun.lock` is stale — `bun install --frozen-lockfile` passes.
- Do not re-confirm that the failing deploy is external Render: `freebuff-deploy status` shows no
  Freebuff deployments.
- Do not re-run the TS7 reproduction to "prove" TS5102 — it is recorded in section 5.

## 12. Verification

Remaining **unverified**:

- That the reported Render failure is specifically `TS5102` — the Render log has not been read.
- That Render redeploys `978b888` successfully and that the live API then serves `/api/models`
  (still 404 on the stale build at the time of writing).
- That the Render service's Root Directory / install / start commands match the configured values in
  `docs/API_ENV.md` (assumed; dashboard not accessible).
- `apps/web` on Vercel after the tsconfig change (typecheck verified only).
- No production build or dev server was started; no Render-side action was taken.
