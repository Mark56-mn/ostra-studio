// scripts/smoke-seasons.ts — ACCEPTANCE TEST for the season-first approval gate, run against the
// LIVE database through the REAL route handlers (not a mock, not a copy of the logic).
//
//   bun scripts/smoke-seasons.ts
//
// It proves the spec's acceptance tests end-to-end:
//   * a broken season package is refused, with every problem named
//   * a season can be drafted, submitted (which raises the human's notification) and approved
//   * NO production task can be created before that approval (409 SEASON_NOT_APPROVED)
//   * after approval the same production task is accepted
//   * script work is never gated
//
// Everything it creates is deleted again (events → notifications → project, which cascades seasons
// and tasks), so the live database is left exactly as it was found.

import assert from "node:assert";
import { createSeason, decideSeason, listSeasons, submitSeason } from "../apps/api/src/routes/seasons.js";
import { createTask } from "../apps/api/src/routes/tasks.js";
import { getServerSupabase } from "../apps/api/src/lib/supabase.js";

type MockRes = {
  statusCode: number;
  body: unknown;
  status(code: number): MockRes;
  json(body: unknown): MockRes;
  setHeader(_k: string, _v: string): MockRes;
};

function mockRes(): MockRes {
  const r: MockRes = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      r.statusCode = code;
      return r;
    },
    json(body: unknown) {
      r.body = body;
      return r;
    },
    setHeader() {
      return r;
    },
  };
  return r;
}

const req = (body: unknown, params: Record<string, string> = {}, query: Record<string, string> = {}) =>
  ({ body, params, query, headers: {} }) as never;

let projectId: string | null = null;
const results: Array<[string, boolean, string]> = [];
function check(name: string, ok: boolean, detail = "") {
  results.push([name, ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const supa = getServerSupabase();
  if (!supa) {
    console.error("SMOKE_ABORT — Supabase is not configured in this environment");
    process.exit(2);
  }

  // 0) a real project to work in
  const slug = `smoke-seasons-${Date.now().toString(36)}`;
  const created = await supa.from("projects").insert({ slug, title: "Smoke test — season gate" }).select("id").single();
  assert.ok(created.data, `could not create the test project: ${created.error?.message}`);
  projectId = created.data!.id as string;

  // 1) a broken package is refused, and every problem is named
  {
    const res = mockRes();
    await createSeason(req({ project_id: projectId, package: { title: "", episodes: [], arcs: [] } }), res as never);
    const body = res.body as { error?: string; details?: string[] };
    check("invalid package is refused (400)", res.statusCode === 400 && body.error === "SEASON_PACKAGE_INVALID", body.details?.slice(0, 2).join(" | "));
  }

  // 2) a real package is created as a draft
  let seasonId = "";
  {
    const res = mockRes();
    await createSeason(
      req({
        project_id: projectId,
        package: {
          title: "Smoke Season",
          premise: "A gate test.",
          episodes: [{ number: 1, title: "One", synopsis: "The gate is proven." }],
          characters: [{ name: "Mei", role: "lead" }],
          arcs: ["the gate"],
          ending: "it closes.",
          assumptions: [{ question: "does it work?", assumption: "yes, proven here" }],
          productionEstimate: { images: 1 },
        },
      }),
      res as never
    );
    const body = res.body as { season?: { id: string; status: string } };
    check("draft season created", res.statusCode === 201 && body.season?.status === "draft", `status=${body.season?.status}`);
    seasonId = body.season?.id ?? "";
  }

  // 3) THE ACCEPTANCE TEST: no production task before approval
  {
    const res = mockRes();
    await createTask(req({ project_id: projectId, type: "image", worker_type: "image", input: {} }), res as never);
    const body = res.body as { error?: string; reason?: string; season_status?: string };
    check(
      "production task REFUSED before approval (409)",
      res.statusCode === 409 && body.error === "SEASON_NOT_APPROVED",
      `${body.error} status=${body.season_status}`
    );
  }

  // 4) script work is never gated
  {
    const res = mockRes();
    await createTask(req({ project_id: projectId, type: "outline", worker_type: "script", input: {} }), res as never);
    check("script task is NOT gated", res.statusCode === 201, `status=${res.statusCode}`);
  }

  // 5) submit → the human's notification is really raised
  {
    const res = mockRes();
    await submitSeason(req({}, { id: seasonId }), res as never);
    const body = res.body as { season?: { status: string } };
    check("season submitted", res.statusCode === 200 && body.season?.status === "submitted", `status=${body.season?.status}`);

    const { data: notes } = await supa.from("notifications").select("kind, requires_action, title").eq("season_id", seasonId);
    const n = (notes ?? [])[0];
    check("notification raised for the human", Boolean(n && n.requires_action === true), `${n?.kind ?? "none"}: ${n?.title ?? ""}`);
  }

  // 6) approving is possible only through the decision route, and it opens the gate
  {
    const res = mockRes();
    await decideSeason(req({ decision: "approved", decided_by: "smoke-test" }, { id: seasonId }), res as never);
    const body = res.body as { season?: { status: string; decided_by?: string } };
    check("season approved by a human decision", res.statusCode === 200 && body.season?.status === "approved", `by=${body.season?.decided_by}`);

    const gate = mockRes();
    await createTask(req({ project_id: projectId, type: "image", worker_type: "image", input: {} }), gate as never);
    check("production task ACCEPTED after approval", gate.statusCode === 201, `status=${gate.statusCode}`);
  }

  // 7) the gate is visible to the dashboard
  {
    const res = mockRes();
    await listSeasons(req({}, {}, { projectId }), res as never);
    const body = res.body as { gates?: Record<string, { allowed: boolean }> };
    check("GET /api/seasons reports an open gate", body.gates?.[projectId!]?.allowed === true, `seasons=${(body as never as { seasons?: unknown[] }).seasons?.length}`);
  }

  // cleanup — the database is left exactly as found
  await supa.from("events").delete().eq("project_id", projectId);
  await supa.from("notifications").delete().eq("project_id", projectId);
  await supa.from("projects").delete().eq("id", projectId);

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("SMOKE_ERROR", e?.message ?? e);
  process.exit(1);
});
