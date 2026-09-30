# HANDOFF — 2026-09-30 — Render deploy fails at START (`Yarn: command not found`)

## 1. Task

The operator pasted the Render deploy log for `main` @ `f86723f` (the Agent Chat thinking/answer
separation commit). The build succeeded; the deploy died at the start step:

```
==> Build successful 🎉
==> Deploying...
==> Running 'Yarn start'
bash: line 1: Yarn: command not found
==> Exited with status 127
```

Task as understood: diagnose it and fix / arrange the fix.

## 2. Result

**Diagnosed. The root cause is entirely Render-side — a misconfigured/auto-detected Start Command — and it
cannot be fixed from this repository.** Repo-side hardening was applied so the failure is harder to reach
and clearly documented.

- The build is not the problem: `bun install` ran fine, `Build successful 🎉`, the artifact uploaded, and
  Render only failed when it tried to run the start command.
- The executed command was literally `Yarn start` (bash echoed `Yarn: command not found` — capital `Y`,
  which is not a binary on the image). The repo ships only `bun.lock`; there is no `yarn.lock`, so nothing
  in the repository justifies a Yarn start command.
- **There is no `render.yaml` / `Procfile` / `Dockerfile` in this repo**, so the Render service's start
  command lives only in the Render dashboard. It is either blank (Render fell back to a Yarn default) or
  literally set to `Yarn start`. Either way the fix is a dashboard edit.
- Repo-side changes (so a package-manager default resolves instead of 404-ing on a missing entry point):
  the workspace root now exposes `start` → `bun --filter @ostra/api start`, and `docs/API_ENV.md` records
  this exact failure signature, the two dashboard values, and the fact that Render cannot be fixed from
  source.
- Verified the intended start path is genuinely runnable: `tsx` resolves in `apps/api/node_modules`, and
  `node --import tsx -e "…"` loads from `apps/api` (see §5).

**Not done (cannot be done from here):** the Render dashboard change itself, and therefore the deploy is
still not live — the previous successful deploy keeps serving.

## 3. Repository state

- Branch `main`. `f86723f` was committed and pushed by the previous turn and is what Render checked out.
- This turn's changes are uncommitted working-tree edits:
  `package.json` (one added script) and `docs/API_ENV.md` (two doc edits), plus this handover.
- `main` is level with `origin/main` apart from those uncommitted files.
- Render: external, operator-managed, **not deployable from this workspace**; it hosts `apps/api` while
  Vercel hosts `apps/web`.

## 4. Files changed

- `package.json` — added `"start": "bun --filter @ostra/api start"` to root scripts (there was none, so any
  package-manager default start at the workspace root had nothing to run).
- `docs/API_ENV.md` — added the root `bun start` alias to the Render settings list, and a new
  deploy-failure checklist entry for exit 127 + `Yarn: command not found` naming the exact fix.
- `handoffs/HANDOFF-2026-09-30-render-start-command.md` — this file.

## 5. Tests/checks

Actually run, from the repo root:

| command | result |
| --- | --- |
| `node -e "JSON.parse(fs.readFileSync('package.json'))"` | `package.json is valid JSON` |
| `grep -n '"start"' package.json` | line 12 — the script is present |
| `(cd apps/api && node --import tsx -e "console.log('tsx loader OK')")` | `tsx loader OK` — the loader the start command depends on resolves from `apps/api` |
| `grep -n "listen" apps/api/src/index.ts` | `app.listen(port, "0.0.0.0", …)` with `PORT ?? 3001` |
| `ls apps/api/node_modules` | `tsx` present (Bun isolated linker; also `node_modules/.bun/tsx@4.23.15`) |
| `find . -iname "render*"` | **nothing** — confirms the Render config is not in the repo |

Deliberately **not** run: `bun --filter @ostra/api start` (it is a long-lived server; starting it in this
workspace is prohibited and would hang the terminal). The loader check above is the safe equivalent.

## 6. Integration status

- **Render** — *unavailable / not attempted for deployment*. This workspace cannot reach or configure the
  service. The diagnosis is from the operator-supplied log, not from the Render API.
- **Supabase** — *connected/verified* in the previous turn (migration `006_chat_reasoning.sql` applied).
- **Vercel** — untouched by this task.
- **Kaggle Script AI** — still unverified (tunnel was offline; unchanged by this task).

## 7. Known issues

1. **The deploy is failing; production API is still the last good build.** Because start never succeeded,
   the new reasoning code is not live — `/api/chat/*` responses still lack the `reasoning` field until the
   Start Command is fixed and the service redeploys.
2. **The dashboard build command has drifted too.** The log shows `Running build command 'bun install'`
   while `docs/API_ENV.md` specifies `bun install && bun --filter @ostra/api build`. Without the second
   half, a TypeScript error can no longer fail the deploy (`build` is the API's `tsc --noEmit`). Worth
   restoring so this class of error is caught at deploy time again.
3. **Restart-loop noise:** Render retried the start twice in the pasted log. A failing start with no
   successful deploy will keep retrying; expect repeated identical entries until the Start Command is set.
4. **`tsx` is a devDependency.** If the dashboard build command ever gains `--production`/`--omit=dev`
   (or `NODE_ENV=production` makes Bun skip dev deps), the *next* start failure will be a `tsx` resolution
   error rather than this one. Already documented in the same checklist.

## 8. Decisions

- **Did not add a `render.yaml`.** A Blueprint file cannot retro-fit an existing non-Blueprint service, so
  it would not fix this deploy; it would only be useful if the service is recreated as a Blueprint. Recorded
  as an option rather than silently adding dead config.
- **Did not change the API to avoid `tsx`** (e.g. precompiling with `tsc` and starting plain `node`). It
  would be a real robustness win but is a much larger change than this failure calls for, and it is not the
  cause.
- **Did not run the start command to "prove" it.** Starting a server in this workspace is prohibited and
  would hang; verified the loader and entry-point instead.

## 9. Environment/configuration

- **The fix is two Render dashboard fields on the API service:**
  - **Start Command:** `bun --filter @ostra/api start`
  - **Build Command:** `bun install && bun --filter @ostra/api build`
  - Root Directory must stay the **workspace root** (not `apps/api`) — `@ostra/shared` is a sibling
    workspace resolved through the API tsconfig `paths`.
- No new environment variables. `PORT` is injected by Render; the API binds `0.0.0.0:$PORT` (local default
  `3001`). Bun is already available on the Render image (`Using Bun version 1.4.2`), Node 26.10.0 is used.
- No migration involved in this task.

## 10. Next agent

**One task: get the operator to set the Render Start Command, then confirm the deploy goes live.**
1. Operator: Render dashboard → the `ostra-studio` API service → Settings → **Start Command** =
   `bun --filter @ostra/api start` (and optionally restore the Build Command above) → save/redeploy.
2. Confirm the log shows `==> Running 'bun --filter @ostra/api start'` and then the API's own line
   `[ostra-api] listening on 0.0.0.0:<port>`.
3. Then confirm the API is reachable (`GET https://ostra-studio-1.onrender.com/health`) and that
   `/api/chat/rooms/:id/messages` now returns `reasoning` on assistant rows (null until a worker that
   thinks answers). That is the outstanding end-to-end check from
   `handoffs/HANDOFF-2026-09-30-agent-thinking.md`.

## 11. Do not redo

- Do not re-diagnose this log: it is a Render Start Command misconfiguration, not a repo build error.
- Do not add a `render.yaml` expecting it to fix this deploy (see §8).
- Do not run `bun run dev` / `bun --filter @ostra/api start` in this workspace to reproduce it.
- Do not "fix" the API's `start` script or its `tsx` dependency — both are correct and verified.
- Do not re-add a root `start` script; it now exists.

## 12. Verification

**Verified:** `package.json` is valid JSON and declares the root `start` script; the start command's target
script exists and is correct (`apps/api/package.json`); `tsx` is installed and loads from `apps/api`; the
API binds `0.0.0.0:$PORT`; there is no Render config file in the repo; the pasted log shows the build
succeeding and only the start step failing.

**Unverified / must be confirmed by the operator or next agent:**
- That the Render Start Command is actually blank vs. literally `Yarn start` — only the dashboard shows it,
  and this workspace cannot read the Render API.
- That setting `bun --filter @ostra/api start` makes the deploy go live and the API serve traffic.
- That `/api/chat/*` then returns `reasoning` — the whole end-to-end Agent Chat check from the previous
  handover remains open, and now also depends on this deploy succeeding.
