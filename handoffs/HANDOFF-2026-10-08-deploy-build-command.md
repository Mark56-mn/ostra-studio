# HANDOFF-2026-10-08 — failed deploy: the hosting build command was invalid

## 1. Task

"The deployment failed — check for errors", then push all changes to GitHub.

## 2. Result

Complete. One real, reproducible cause was found and fixed.

**Root cause.** The project's saved hosting **build command** was
`bun --filter @ostra/web run build`. Under bun 1.4.2 (the version in this workspace) the first bare
token after `--filter <pkg>` is parsed as the *script name*, so that command looks for a script literally
called `run` and dies immediately:

```
$ bun --filter @ostra/web run build
error: Script "run" not found in package "@ostra/web"
EXIT=1
```

The working form — and the one the repo's own root script already used — is without the `run` token:

```
$ bun --filter @ostra/web build
✓ Compiled successfully        EXIT=0
```

So the deploy failed at the build step before anything could be recorded: `freebuff-deploy status`
reported `latestDeployment: null` ("No deployments yet"), which is consistent with a build that never
produced a deployment.

**Fix.** `freebuff-preview set-build "bun --filter @ostra/web build"` (the install command `bun install`
and preview command `bun --filter @ostra/web dev` were already correct and working). `freebuff-deploy
check` now reports `deployable: true`, `problems: []` with both effective commands equal to the
configured ones.

## 3. Repository state

- Branch `main` at `f758d8e` before this session's commit; the working tree holds the NVIDIA model re-pin
  from the previous task plus this task's README note.
- Build artifacts (`.next/`) are gitignored — running the builds left the tree clean, verified with
  `git status --porcelain`.

## 4. Files changed

- `README.md` — the "Typecheck + build" block now also documents the **deploy** build commands for the
  hosting step, with an explicit warning that the `run` token is wrong and the exact error it produces.
  (No source file needed changing: the bug was in the saved hosting config, not in the repo.)
- No change was needed to `package.json` — its root `build` (`bun --filter @ostra/web build`), `build:all`
  and `start` scripts were already correct, which is why the drift was invisible until a deploy ran.

## 5. Tests/checks

| Command | Result |
| --- | --- |
| `bun --filter @ostra/web run build` (the old saved command) | **exit 1** — `Script "run" not found in package "@ostra/web"` |
| `bun --filter @ostra/web build` (the fixed command) | **exit 0** — `✓ Compiled successfully` |
| `bun --filter @ostra/api build` | **exit 0** — `tsc --noEmit`, no output |
| `freebuff-preview status` | running, listening, HTTP 200; dev logs show only 200s from `/` and `/api/health` |
| `freebuff-deploy check` (after the fix) | `deployable: true`, `problems: []` |
| `freebuff-deploy status` | `latestDeployment: null`, `unresolvedBuildErrorCount: 0` |
| `freebuff-deploy start` | refused: "This project has never been deployed. The user must run the first deploy (and choose a domain) from the Deploy button." |

The NVIDIA work from the previous task is unchanged and still green: `bun test` 399 pass / 0 fail,
`bun run typecheck` exit 0, `bun run lint` exit 0 (run before this task; no source file changed since).

## 6. Integration status

- **Freebuff hosting — configured but unverified.** The build command is fixed and `check` is green, but
  no deployment has been produced: the first deploy is operator-initiated (Deploy button + domain), and
  `freebuff-deploy start` correctly refused. So the fix is verified at the command level, not by a
  successful deployed build.
- **Render (`apps/api`) — not attempted, not verified this turn.** Its documented settings
  (`docs/API_ENV.md` → "Render build & start") use the correct form already. If the user's failing
  deployment was the Render service rather than the Freebuff/Vercel one, nothing in this repo is the
  cause: both build commands are green, and that document's "Deploy-failure checklist" already covers the
  known Render-specific failure (unset Start Command → `Yarn: command not found`, exit 127).
- **Vercel (`apps/web`) — not attempted, not verified.** No Vercel config in the repo; it builds
  `apps/web` with `NEXT_PUBLIC_API_URL` only.

## 7. Known issues

- The workspace preview and the deploy builder both run `@ostra/web dev`/`build`; neither has ever been
  exercised as a *deployed* artifact here, so a hosting-specific failure after a green build is still
  possible and would need `freebuff-deploy logs` after the first deploy exists.
- `freebuff-deploy status` reports no build errors simply because no deployment exists; it is not evidence
  that a deploy will succeed.

## 8. Decisions

- **Fix the config, not the repo.** The repo scripts were already right; changing them to match a broken
  saved command would have encoded the bug. The saved build command now matches `package.json`.
- **Reproduce before repairing.** The diagnosis came from running the exact saved command and its
  corrected twin, not from reading the config — the two differ by one token and only one exits 0.
- **Document the trap next to the commands** so a future platform re-detection or a copy-paste does not
  reintroduce the `run` token.

## 9. Environment/configuration

- Hosting: install `bun install`; preview `bun --filter @ostra/web dev` (port 3000); build
  `bun --filter @ostra/web build`. All three saved on the project.
- No env var changed; no secret touched. `.env` / `.env.local` were not read.
- The Render API service and the Vercel frontend are operator-managed dashboards; production env vars for
  them are separate from this workspace's `.env`.

## 10. Next agent

If the user reports another deploy failure, first run `freebuff-deploy logs` (only meaningful once a
deployment record exists), then confirm the deployed build command with `freebuff-deploy check` before
touching source. For the Render service, walk the checklist in `docs/API_ENV.md` — an unset **Start
Command** (`bun --filter @ostra/api start`) is its historic failure mode.

## 11. Do not redo

- Do not add `run` back to any `bun --filter <pkg> <script>` command; do not "fix" this by editing
  `package.json`, which was correct.
- Do not re-run `freebuff-deploy start` expecting it to work before the first Deploy-button deploy exists.
- Do not re-diagnose the NVIDIA model re-pin — it is done and verified (see
  `handoffs/HANDOFF-2026-10-08-nvidia-model-repin.md`).

## 12. Verification

- **Verified:** the old build command fails with exit 1 and the exact message; the corrected command
  builds green (exit 0); the API build is green; the preview serves 200; `freebuff-deploy check` is green.
- **Not verified:** an actual hosted deployment (requires the user's first Deploy-button deploy, which
  also picks the domain); Render/Vercel dashboards and their logs were not reachable from this workspace;
  production env vars were not inspected.
