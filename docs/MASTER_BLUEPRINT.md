# Ostra Studio — Master Product Blueprint

**Status:** Product and architecture north star  
**Repository:** https://github.com/Mark56-mn/ostra-studio  
**Canonical planning reference:** Ostra master blueprint in Notion  
**Implementation rule:** inspect the live repository before changing architecture; preserve working code and production configuration.

This document is the version-controlled project reference for all human and AI contributors. If a detail conflicts with the current implementation, document the gap and propose a task; do not silently overwrite working behavior. Update this file when an approved product or architecture decision changes.

## 1. Product vision

Ostra Studio is a multi-tenant SaaS platform for creating, managing, and publishing original manhwa/storytelling videos through a supervised autonomous AI studio. It is not just a chatbot or a mock dashboard.

A customer should be able to define a series, build its Story Bible, assign an episode goal, and let a Studio Director coordinate specialized agents through writing, scene planning, image generation, narration, subtitles, assembly, quality checks, and YouTube publishing. The system should continue safe work without waiting for the customer, but ask for help or approval when a decision crosses configured policy, canon, spending, rights, or publishing boundaries.

**Initial production target:** one finished episode/video per week, with a path to higher throughput after reliability and cost are measured.

## 2. Product principles

1. **Real work, real state:** never represent mocked, inferred, or unverified output as a completed job, connected provider, rendered video, or published video.
2. **Durable autonomy:** jobs, messages, approvals, agent assignments, retries, and outcomes survive process restarts and sleeping services.
3. **Customer control:** customers own their workspaces, story IP, permissions, integrations, budgets, and publication policy.
4. **Tenant isolation from the first schema:** every customer-owned record is workspace-scoped and protected server-side and through Supabase RLS where applicable.
5. **Canon protection:** proposed story facts and changes remain drafts until accepted under the workspace's configured canon policy. Never silently rewrite approved canon.
6. **Provider independence:** models, compute workers, media storage, and video rendering are replaceable through documented adapters.
7. **Cost transparency:** meter usage and actual costs before setting paid prices. Do not promise unlimited generation on a free plan.
8. **Mobile-first usability:** core workflows must work on a phone, not only a desktop.
9. **Least privilege:** keep credentials server-side, redact logs, scope integrations, and use explicit permissions for irreversible actions.
10. **Human authority:** global pause, budget caps, approval policy, and customer-requested stop/cancel take precedence over agent autonomy.

## 3. Deployment and system boundaries

Initial deployment direction:
- **Vercel:** customer-facing website, dashboard, and frontend.
- **Render:** backend API and orchestration/control plane. Account for free-tier sleeping and limits; never claim always-on availability unless the deployed plan supports it.
- **Supabase:** Postgres system of record, authentication integration, RLS, and metadata. Keep large binary media out of database rows.
- **Kaggle:** initial script/story AI worker where supported and available. Treat notebook runtime/URLs as ephemeral; health-check and reconnect.
- **Google Colab or customer-managed worker:** initial image/voice or other compute workers only through supported authentication and an explicit worker protocol. Do not assume a generic API key provides a stable Colab execution API.
- **Cloudinary:** media adapter for images, thumbnails, transformations, CDN delivery, previews, and small video assets within current account quotas.
- **Alternative object storage:** portable storage adapter for large final video files and assets that exceed Cloudinary or Supabase practical quotas.
- **Video renderer:** independently replaceable worker/runtime for FFmpeg or equivalent. Do not assume the Render API service is suitable for heavy video rendering.

The backend is authoritative for authz, credits, policy, task state, and publishing state. The frontend must never decide these by itself.

## 4. Multi-tenant SaaS and security

Create explicit workspace/tenant ownership from the beginning. At minimum, model workspaces, memberships/roles, projects/series, episodes, Story Bible entities, assets, jobs, agent messages, approvals, provider connections, compute workers, usage/credit ledger, publishing connections, audit events, and notifications.

Required controls:
- Enforce authorization on every API operation; do not trust workspace IDs supplied by the browser without membership checks.
- Apply Supabase RLS to tenant-owned tables and test cross-tenant read/write denial.
- Keep service-role keys and provider secrets exclusively in server-side secret storage/environment variables.
- Customer-owned saved keys must be write-only after submission: display provider/name/status and a masked indicator, never return the original secret. Allow replace/revoke.
- Never put credentials in source, prompts, client bundles, task files, handoffs, logs, telemetry, screenshots, or Git history.
- Validate webhook signatures and worker identity; use scoped tokens, expiry, rotation, and revocation.
- Add audit events for sensitive changes, secret changes, approvals, spending, and publishing actions.
- Apply rate limits, payload validation, safe error messages, and bounded retries.
- Provide a global pause/kill switch and per-workspace pause, cancel, and budget controls.

## 5. Plans, free credits, and billing

The initial free plan includes **exactly 100 writing credits**. Eligible actions: story ideas and development, outlines, worldbuilding, Story Bible drafting, character profiles, episode planning, scripts, dialogue, scene descriptions, revisions, and continuity checks.

Free writing credits must **not** pay for image generation, voice/audio generation, video rendering, or other production costs. The backend enforces this restriction regardless of frontend UI. Production may use a customer's own connected compute/storage when supported, but still needs fair-use, storage, concurrency, and safety controls.

Credit system requirements:
- configurable rates by action/model/plan;
- atomic reservation, settlement, and release;
- race-safe balance updates;
- idempotent charging tied to job/action IDs;
- refunds/releases on confirmed failure according to policy;
- no double charge on retries or duplicate webhooks;
- immutable ledger entries and customer-visible usage history;
- hard denial when balance/entitlement is insufficient.

Do not set paid plan prices until measured usage is available. Benchmark writing, image, audio, retries, storage, video bandwidth/rendering, infrastructure, payment fees/taxes, support, and desired margin first. Present a pricing proposal for explicit approval before implementing live billing.

## 6. AI provider and model routing

Use provider-neutral interfaces for text generation, image generation, audio/voice, embeddings if needed, and structured tool calls. Initially support eligible free NVIDIA and OpenRouter models where available and terms permit. Providers/models and quotas change, so maintain configuration and health checks rather than hardcoding a single model into the product.

Requirements:
- model selection by task role and workspace policy;
- per-provider timeouts, retries, rate limits, structured-output validation, and failure classification;
- explicit distinction between provider unavailable, credentials invalid, quota exhausted, timeout, and model refusal;
- safe fallback only where the task's policy allows it;
- per-job model/provider attribution, usage and cost records when returned;
- secret redaction and no client exposure;
- configurable budgets and concurrency caps;
- no quota evasion by rotating keys. Multiple keys may be supported for legitimate account/project attribution or provider-supported failover, subject to provider terms.

Keep agent role definitions separate from credential storage. Never promise a free model is permanently available.

## 7. Customer-owned compute and worker protocol

Customers may connect multiple supported Kaggle, Colab-compatible, or customer-managed workers and choose which task types can route to each. Each connection needs a health/last-seen status, supported capabilities, capacity/concurrency, expiry state, permissions, and revocation.

Define a versioned worker contract:
- authenticated registration/heartbeat;
- capability declaration (script, image, voice, rendering, etc.);
- pull or signed dispatch of a bounded job;
- job ID and idempotency key;
- input references and output schema;
- progress events and structured logs with secrets removed;
- artifact upload via short-lived signed URLs or supported media adapters;
- completion/failure status, error category, runtime/usage;
- cancellation and timeout behavior;
- worker lease expiry, retry policy, and recovery when a notebook sleeps or disconnects.

Never assume arbitrary Colab API keys or notebook URLs create a reliable execution service. Document the supported setup and limitations honestly. Route to platform-managed compute only if it is actually configured and budgeted.

## 8. Studio Director and specialist agents

### Studio Director / CEO agent
Receives the customer's goal and policy, consults the Story Bible and production state, decomposes work into dependency-aware tasks, assigns specialists, checks deadlines, reconciles claims against persisted artifacts, resolves safe decisions within policy, requests human input when needed, and reports outcomes.

### Specialist roles
- **Story/Script Agent:** concepts, outlines, canon-aware scripts, dialogue, scene breakdowns.
- **Image Agent:** character/location references, shot prompts, image generation, consistency checks.
- **Voice Agent:** narration and character voices, audio, timing metadata.
- **Assembly/Video Agent:** timeline, audio/image synchronization, subtitles, transitions, render orchestration.
- **Quality/Continuity Agent:** story, visual, audio, subtitle, technical, policy, and canon checks.
- **Publishing Agent:** YouTube metadata, OAuth connection, upload/scheduling and read-back verification.

A role may be backed by different models/workers over time. Specialist outputs must be structured and include artifact references, relevant canon version, warnings, and explicit status. The Director validates actual database state and artifacts, not just an agent's claim that it succeeded.

Each durable task should carry: task ID, parent goal/episode, workspace, assignee/role, dependencies, input references, expected output schema, artifacts, canon version, deadline, budget ceiling, permissions, retry/idempotency data, and acceptance criteria.

## 9. Durable autonomy, queue, and recovery

Represent work as persisted state machines rather than in-memory chains. Use leases/locks, idempotency keys, bounded concurrency, per-tenant fairness, timeouts, cancellation, retry/backoff, and dead-letter handling. Recovery must resume or safely requeue work after Render restarts, notebook loss, or worker failure without duplicating charges or public uploads.

Suggested task states: queued, acknowledged, processing, waiting_for_worker, waiting_for_approval, completed, failed, blocked, cancelled, superseded, dead_letter. Define valid transitions and record every transition with timestamps and reason.

Incoming user requests and agent-to-agent messages are durable records with priority (critical/high/normal/low), deduplication, status, retries, and audit history. Batch routine notifications without dropping or merging conflicting/important instructions. Respect notification preferences and quiet hours while ensuring critical alerts remain visible.

Agent Room requirements:
- persistent workspace-scoped conversations, mentions, questions, progress, review requests, and artifact links;
- bounded messages and discussion rounds; no endless debate;
- deadlines and escalation rules;
- clear assignment/ownership and handoff;
- structured check-ins before deadlines with completed outputs, work in progress, remaining work, blockers, quality risks, and ETA;
- Director reconciliation against real task/artifact records.

The Director's final report must state outcome, artifacts, publish state, actual known usage/cost, retries/errors, unresolved risks, and next step. Distinguish **rendered**, **uploaded private/unlisted**, **scheduled**, and **publicly published**. Verify YouTube state by read-back before claiming upload or publication success.

## 10. Story Bible — core product capability

The Story Bible is a first-class, searchable, versioned workspace record, not a single text box. It should cover:
- series premise, themes, genre, tone, audience and style rules;
- world rules, locations, organizations, powers, terminology and timelines;
- characters, appearance, personality, motivations, relationships, voice profile, reference images and evolution;
- season/arc/episode outlines;
- episode scripts, dialogue, scene breakdowns and shot lists;
- image prompts, generated images, revisions and reference links;
- narration/voice assets, subtitles, music/SFX and timing;
- rendered video versions, QA reports, publishing metadata and release history;
- canon facts, unresolved questions, contradictions, approvals and change history.

Every asset must link to the relevant workspace, series, episode, scene, character, task, prompt, model/provider, timestamps, and version where applicable. Preserve provenance and revisions. Separate proposed facts from approved canon. Support search, compare/version history, accept/reject changes, export, and continuity checks. An agent must cite the canon version it used and flag contradictions instead of silently choosing a new truth.

## 11. Production pipeline

Expected end-to-end workflow:
1. Customer creates a workspace and series, configures policies, providers, workers, budgets, and YouTube connection.
2. Director creates or updates a production plan and obtains any required approval.
3. Script Agent produces outline/script/scenes; continuity validation runs against approved canon.
4. Image Agent creates or routes reference-consistent images and records prompts/provider/worker/output metadata.
5. Voice Agent produces narration/voices and timing; subtitles are generated and checked.
6. Assembly worker creates a timeline and renders a video using replaceable components.
7. Quality Agent checks story continuity, missing assets, audio levels, subtitles, dimensions, duration, and configured content/publishing rules.
8. Failed checks create bounded repair tasks; retries respect deadlines and budgets.
9. Customer review/approval occurs according to workspace policy.
10. Publishing Agent uploads as private/unlisted by default, verifies via read-back, then schedules or publishes only if explicitly authorized.
11. Director reports verified outcome and archives all episode artifacts in the Story Bible.

Every stage needs real status, progress, retry behavior, cancellation, artifacts, and error reporting. A pipeline that has no configured provider/worker must clearly report unavailable/needs setup instead of returning fabricated success.

## 12. YouTube and approval policy

Use official YouTube OAuth/API flows and least-privilege scopes. Protect refresh tokens server-side. Handle expired/revoked consent, quota errors, upload retries, and idempotency. Keep channel connections workspace-scoped and auditable.

Default policy:
- upload privately or unlisted;
- require customer approval before public release;
- do not publicly publish, schedule publicly, spend money, change canon, or change sensitive integrations unless the relevant workspace policy explicitly grants that permission;
- allow customer-configured autonomous public publishing only after explicit opt-in and visible settings;
- provide pause/cancel and verify final status through API read-back.

## 13. Media and storage strategy

Use provider-neutral storage interfaces and durable metadata. Cloudinary Free is a limited shared quota (currently described as 25 credits across storage, transformations, and bandwidth, with a listed 100 MB maximum video size); verify current official limits before implementation because plans change. It is suitable for early image assets, thumbnails, transformations, CDN delivery, previews, and small media within quota, not an unlimited video archive.

Use alternative object storage for large final renders when needed. Keep media portable and avoid provider-specific URLs leaking throughout the domain model. Supabase stores metadata, permissions, and pointers; do not put large binary files directly in database rows. Implement quota/usage monitoring, retention, deletion, signed access, and export.

## 14. Frontend and user experience

Build a premium, responsive, mobile-first SaaS interface with a consistent design system (dark charcoal, white/gray surfaces, restrained violet accent). Avoid decorative dashboards that do not map to real data. All status badges and metrics must be backed by real backend state.

Target pages:
- public: Home, Features, Pricing, Showcase, Sign in, Sign up;
- app: Command Center, Projects & Series, Story Bible, Episode Workshop, Autonomous Agents, Production Pipeline, Media Library, Publishing & Channels, Activity & Approvals, Inbox/Agent Room, Settings & Integrations, Usage & Credits.

Include onboarding, empty/loading/error/offline states, keyboard/accessibility basics, mobile navigation, and clear recovery actions. Do not expose credentials or raw sensitive provider errors in UI.

## 15. Observability, quality, and release criteria

Record structured logs, correlation IDs, workspace/task/job IDs, provider timings, state transitions, sanitized error categories, retries, usage, and costs. Never log secrets, OAuth tokens, private signed URLs, or full sensitive prompts where not required. Add health/readiness checks that test actual dependencies; do not return "online" solely because a route exists.

Automated tests must cover:
- tenant isolation and RLS;
- authentication/authorization and secret redaction;
- 100 writing credits and rejection of free-tier production generation;
- atomic ledger, retries, duplicate requests/webhooks, and refund/release rules;
- provider/worker offline, timeout, expired credentials, and malformed output;
- durable queue transitions, lease expiry, cancellation, dead-letter and restart recovery;
- Story Bible versioning/canon protection;
- approval policy and YouTube upload idempotency/read-back;
- cost limits, global pause, and audit events.

First production release acceptance:
1. tenant isolation is tested;
2. writing credits are enforced server-side and cannot pay for production generation;
3. secrets are protected and redacted;
4. providers and customer-owned compute route through documented adapters;
5. durable queue and Director survive restart/retry safely;
6. Agent Room is persistent and bounded;
7. Story Bible stores versioned, linked, traceable assets and canon;
8. at least one end-to-end episode can be created with real configured workers and verified artifacts;
9. YouTube upload status is read back and distinguished from public publication;
10. mobile workflows, monitoring, rollback, setup documentation, and security tests are present;
11. pricing is based on measured cost data, not guesswork;
12. no secrets are committed.

## 16. Build and agent operating contract

Before editing, every coding agent must read:
1. root `AGENT_HANDOFF.md`;
2. `tasks/README.md`;
3. `tasks/ROADMAP.md`;
4. the exact assigned task file;
5. this `docs/MASTER_BLUEPRINT.md`;
6. relevant existing architecture/context docs and current implementation.

Work only on the assigned task. Inspect current code and preserve existing functionality; do not perform a broad rewrite unless the task explicitly authorizes it. Do not deploy, alter production secrets/configuration, merge branches, or perform destructive changes unless explicitly authorized.

Each task should be independently testable and sized for approximately 30–50 minutes of agent work. Task files must specify goal, context, scope/out-of-scope, exact likely files, implementation steps, acceptance criteria, test commands, security/rollback notes, and exact next task.

After every task—including blocked or partial tasks—the agent must update root `AGENT_HANDOFF.md` with task ID, files changed, actual commands/tests and outcomes, commit/branch when known, risks, unfinished work, and the exact next task filename. Do not claim tests passed unless they were actually run. Keep the handoff concise but sufficient for a fresh agent with no conversation history.

## 17. Task roadmap

### Phase A — Audit and foundation
- TASK-000: read-only repository audit; inventory code, deployments, migrations, tests, secrets handling, current branches and risks.
- TASK-001: establish branch and task/handoff conventions after inspecting current state.
- TASK-002: create/align repository skeleton without breaking current deployments.
- TASK-003: lint, typecheck, tests and CI baseline.
- TASK-004: architecture, deployment boundaries, environment variable and rollback docs.

### Phase B — Tenant, auth, and credits
- TASK-010: tenant/workspace schema and migrations.
- TASK-011: auth, membership, roles and RLS.
- TASK-012: cross-tenant isolation tests.
- TASK-013: plan entitlements and 100 writing credits.
- TASK-014: atomic credit ledger, reservation, settlement and release.
- TASK-015: deny free-tier production generation server-side.

### Phase C — Providers, secrets, media, and workers
- TASK-020: provider-neutral interfaces.
- TASK-021: secret access controls and redaction.
- TASK-022: NVIDIA adapter.
- TASK-023: OpenRouter adapter.
- TASK-024: per-role model routing and fallback policy.
- TASK-025: Cloudinary adapter and quota monitoring.
- TASK-026: alternative object-storage adapter for large renders.
- TASK-027: versioned customer-worker protocol.
- TASK-028: supported Kaggle connection/dispatch.
- TASK-029: supported Colab/customer-managed worker path and documented limits.

### Phase D — Durable autonomy and communication
- TASK-030: durable job schema/state, leases, idempotency, retry, cancellation and recovery.
- TASK-031: queue fairness, concurrency, backoff and dead-letter handling.
- TASK-032: durable inbound and agent message queue.
- TASK-033: specialist role contracts and structured outputs.
- TASK-034: Director delegation and result validation.
- TASK-035: persistent bounded Agent Room.
- TASK-036: deadline check-ins and escalation.
- TASK-037: owner reports and notification preferences.
- TASK-038: audit, monitoring, global pause and budget guardrails.

### Phase E — Story Bible and application UX
- TASK-040: design system and mobile shell.
- TASK-041: public pages and authentication UX.
- TASK-042: Command Center and onboarding.
- TASK-043: Story Bible schema and versioning.
- TASK-044: Story Bible APIs, access checks, search and export.
- TASK-045: Story Bible UI.
- TASK-046: Inbox/Agent Room UI.
- TASK-047: provider/compute settings.
- TASK-048: usage, credits and activity UI.

### Phase F — Production and YouTube
- TASK-050: episode planning, scripts and scenes.
- TASK-051: image generation and reference consistency.
- TASK-052: voice, audio and subtitles.
- TASK-053: assembly/render worker.
- TASK-054: quality/continuity checks and bounded repair.
- TASK-055: YouTube OAuth and channel connection.
- TASK-056: private/unlisted upload with idempotency.
- TASK-057: read-back verification, scheduling and approval policy.
- TASK-058: end-to-end episode acceptance test.

### Phase G — Cost, security, and pilot
- TASK-060: provider usage and cost ledger.
- TASK-061: benchmark model and episode costs.
- TASK-062: customer-worker cost and fair-use analysis.
- TASK-063: propose pricing after costs, payment fees, taxes, support and margin are measured.
- TASK-064: implement billing only after pricing approval.
- TASK-065: failure-injection, security and recovery tests.
- TASK-066: limited pilot, monitoring and rollback plan.

## 18. Immediate next step

Start with TASK-000 as a read-only repository audit. Do not assume the roadmap files or proposed branch already exist. Verify current repository state, preserve working production code/configuration, and report exact findings before implementing the new architecture. Create or update task/handoff documents only as appropriate after confirming existing paths. Do not start a full rewrite or deploy changes as part of the audit.

## 19. Decisions requiring evidence or owner approval

- Paid plan prices: TBD until measured costs and margins are available.
- Public auto-publishing: off by default; requires explicit workspace opt-in.
- Provider/worker availability and quotas: verify live behavior; do not promise permanent free availability.
- Storage limits and pricing: re-check current provider plans before committing to an implementation.
- Any irreversible migration, production deployment, destructive change, or sensitive permission change: explicit approval required.
