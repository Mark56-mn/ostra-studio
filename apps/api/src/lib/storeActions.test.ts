// apps/api/src/lib/storeActions.test.ts
// Exercises the real store-write logic against a small in-memory Supabase stand-in, so the rules
// that matter can be asserted without a live database:
//   - an agent action writes the row it claims to write, or reports a real failure
//   - nothing is ever reported as applied when the write did not happen
//   - every applied write leaves an audit row, a refused one leaves none
import assert from "node:assert";
import { describe, it } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentAction } from "@ostra/shared";
import { applyStoreActions } from "./storeActions.js";

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string; code?: string } | null };

class FakeSupabase {
  rows: Record<string, Row[]> = { projects: [], characters: [], locations: [], episodes: [], scenes: [], events: [] };
  /** Column that must stay unique per table, so slug-collision handling is exercised for real. */
  unique: Record<string, string> = { projects: "slug" };
  failWritesOn = new Set<string>();
  private seq = 0;
  nextId(): string {
    this.seq += 1;
    return `id-${this.seq}`;
  }
  from(table: string): FakeQuery {
    if (!this.rows[table]) this.rows[table] = [];
    return new FakeQuery(this, table);
  }
}

class FakeQuery implements PromiseLike<Result> {
  private filters: Array<(row: Row) => boolean> = [];
  private action: { kind: "select" } | { kind: "insert"; payload: Row } | { kind: "update"; payload: Row } | null = null;
  private ordering: { col: string; ascending: boolean } | null = null;
  private max: number | null = null;
  private singleMode: "single" | "maybe" | null = null;

  constructor(private db: FakeSupabase, private table: string) {}

  select(): this {
    if (!this.action) this.action = { kind: "select" };
    return this;
  }
  insert(payload: Row | Row[]): this {
    this.action = { kind: "insert", payload: Array.isArray(payload) ? payload[0] : payload };
    return this;
  }
  update(payload: Row): this {
    this.action = { kind: "update", payload };
    return this;
  }
  eq(col: string, value: unknown): this {
    this.filters.push((r) => r[col] === value);
    return this;
  }
  ilike(col: string, value: string): this {
    const needle = value.toLowerCase();
    this.filters.push((r) => String(r[col] ?? "").toLowerCase() === needle);
    return this;
  }
  in(col: string, values: unknown[]): this {
    this.filters.push((r) => values.includes(r[col]));
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.ordering = { col, ascending: opts?.ascending !== false };
    return this;
  }
  limit(n: number): this {
    this.max = n;
    return this;
  }
  maybeSingle(): Promise<Result> {
    this.singleMode = "maybe";
    return this.exec();
  }
  single(): Promise<Result> {
    this.singleMode = "single";
    return this.exec();
  }
  then<T1 = Result, T2 = never>(
    onfulfilled?: ((value: Result) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null
  ): PromiseLike<T1 | T2> {
    return this.exec().then(onfulfilled, onrejected);
  }

  private rejected(): boolean {
    return this.db.failWritesOn.has(this.table);
  }

  private async exec(): Promise<Result> {
    const rows = this.db.rows[this.table];
    if (!this.action) return { data: null, error: { message: "no action" } };

    if (this.action.kind === "insert") {
      if (this.rejected()) return { data: null, error: { message: `write refused on ${this.table}`, code: "42501" } };
      const row: Row = { ...this.action.payload };
      if (!row["id"]) row["id"] = this.db.nextId();
      const uniqueCol = this.db.unique[this.table];
      if (uniqueCol && rows.some((r) => r[uniqueCol] === row[uniqueCol])) {
        return { data: null, error: { message: `duplicate key value violates unique constraint "${this.table}_${uniqueCol}_key"`, code: "23505" } };
      }
      rows.push(row);
      return { data: row, error: null };
    }

    if (this.action.kind === "update") {
      if (this.rejected()) return { data: null, error: { message: `write refused on ${this.table}`, code: "42501" } };
      const matched = rows.filter((r) => this.filters.every((f) => f(r)));
      for (const r of matched) Object.assign(r, this.action.payload);
      return { data: matched[0] ?? null, error: null };
    }

    let matched = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.ordering) {
      const { col, ascending } = this.ordering;
      matched = [...matched].sort((a, b) => (Number(a[col] ?? 0) - Number(b[col] ?? 0)) * (ascending ? 1 : -1));
    }
    if (this.max !== null) matched = matched.slice(0, this.max);
    return { data: this.singleMode ? matched[0] ?? null : matched, error: null };
  }
}

function setup(seed?: { projects?: Row[]; episodes?: Row[]; scenes?: Row[] }): { db: FakeSupabase; supa: SupabaseClient } {
  const db = new FakeSupabase();
  if (seed?.projects) db.rows["projects"] = seed.projects;
  if (seed?.episodes) db.rows["episodes"] = seed.episodes;
  if (seed?.scenes) db.rows["scenes"] = seed.scenes;
  return { db, supa: db as unknown as SupabaseClient };
}

const inkProject: Row[] = [{ id: "p1", slug: "crimson-ink", title: "Crimson Ink", logline: null, story_bible: {} }];

describe("applyStoreActions", () => {
  it("writes the character it says it wrote, and audits it", async () => {
    const { db, supa } = setup({ projects: inkProject });
    const actions: AgentAction[] = [{ op: "create_character", data: { name: "Kai", role: "protagonist" } }];

    const res = await applyStoreActions(supa, actions, "p1");

    assert.equal(res.changed, 1);
    assert.equal(res.failed, 0);
    assert.equal(res.applied[0].ok, true);
    assert.equal(res.applied[0].summary, 'Created character "Kai"');
    assert.deepEqual(db.rows["characters"], [
      { id: "id-1", project_id: "p1", name: "Kai", role: "protagonist", description: null, visual_ref: null },
    ]);
    assert.equal(db.rows["events"].length, 1);
    assert.deepEqual(
      { type: db.rows["events"][0]["type"], op: (db.rows["events"][0]["payload"] as Row)["op"] },
      { type: "agent.store_change", op: "create_character" }
    );
  });

  it("refuses an update to an episode that does not exist instead of creating one", async () => {
    const { db, supa } = setup({ projects: inkProject, episodes: [{ id: "e1", project_id: "p1", number: 1, title: "First Stroke" }] });

    const res = await applyStoreActions(supa, [{ op: "update_episode", data: { number: 7, title: "Ghost" } }], "p1");

    assert.equal(res.changed, 0);
    assert.equal(res.failed, 1);
    assert.equal(res.applied[0].ok, false);
    assert.match(res.applied[0].error ?? "", /no EP 7/);
    assert.equal(db.rows["episodes"].length, 1);
    assert.equal(db.rows["episodes"][0]["title"], "First Stroke");
    assert.equal(db.rows["events"].length, 0);
  });

  it("derives a valid slug and retries a collision with a numbered suffix", async () => {
    const { db, supa } = setup({ projects: inkProject });

    const res = await applyStoreActions(supa, [{ op: "create_project", data: { title: "Crimson Ink" } }], null);

    assert.equal(res.changed, 1);
    assert.deepEqual(db.rows["projects"].map((p) => p["slug"]), ["crimson-ink", "crimson-ink-2"]);
  });

  it("appends a scene after the last index of the named episode", async () => {
    const { db, supa } = setup({
      projects: inkProject,
      episodes: [{ id: "e1", project_id: "p1", number: 1, title: "First Stroke" }],
      scenes: [{ id: "s1", episode_id: "e1", index: 0, title: "Ink spills" }],
    });

    const res = await applyStoreActions(supa, [{ op: "create_scene", data: { episode_number: 1, title: "The brush speaks" } }], "p1");

    assert.equal(res.changed, 1);
    assert.equal(res.applied[0].ref, "scene:EP1#1");
    assert.equal(db.rows["scenes"].length, 2);
    assert.equal(db.rows["scenes"][1]["index"], 1);
    assert.equal(db.rows["scenes"][1]["episode_id"], "e1");
  });

  it("reports a database refusal as a failure, never as a success", async () => {
    const { db, supa } = setup({ projects: inkProject });
    db.failWritesOn.add("characters");

    const res = await applyStoreActions(supa, [{ op: "create_character", data: { name: "Kai" } }], "p1");

    assert.equal(res.changed, 0);
    assert.equal(res.applied[0].ok, false);
    assert.match(res.applied[0].error ?? "", /write refused on characters/);
    assert.equal(db.rows["characters"].length, 0);
    assert.equal(db.rows["events"].length, 0);
  });

  it("points later actions in the same batch at a project the agent just created", async () => {
    const { db, supa } = setup();

    const res = await applyStoreActions(
      supa,
      [
        { op: "create_project", data: { title: "New World", logline: "A fresh start." } },
        { op: "create_character", data: { name: "Rin" } },
      ],
      null
    );

    assert.equal(res.changed, 2);
    const project = db.rows["projects"][0];
    assert.equal(db.rows["characters"][0]["project_id"], project["id"]);
  });

  it("never writes when an action has no target project at all", async () => {
    const { db, supa } = setup();

    const res = await applyStoreActions(supa, [{ op: "create_character", data: { name: "Kai" } }], null);

    assert.equal(res.changed, 0);
    assert.match(res.applied[0].error ?? "", /no project/);
    assert.equal(db.rows["characters"].length, 0);
  });
});
