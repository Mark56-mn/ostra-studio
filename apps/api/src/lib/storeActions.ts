// apps/api/src/lib/storeActions.ts
// Executes the store changes an AI agent asked for in the Agent Chat room.
//
// Truth rules:
//  - Every action writes a REAL Supabase row through the same column allow-lists the REST routes
//    use, so chat cannot put the store into a shape the rest of the app rejects.
//  - Additive only. There is no delete path here, by design (CONSTRAINTS.md #12/#13).
//  - A per-action result is returned even when the action fails, and each success is written to the
//    `events` audit log (#20). Nothing is reported as applied unless the insert/update succeeded.
//  - Entities are addressed by human handles (project slug/title, character name, episode number,
//    scene index) because that is what a model can reliably copy from its context — never by id.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  classifySlugWriteError,
  resolveProjectSlug,
  slugCandidates,
  type AgentAction,
  type AgentStoreSnapshot,
} from "@ostra/shared";

export type StoreEntity = "project" | "character" | "location" | "episode" | "scene";

export type AppliedAction = {
  op: string;
  ok: boolean;
  entity: StoreEntity | null;
  /** Human handle of the row that changed, e.g. `character:Kai`. */
  ref: string | null;
  id: string | null;
  summary: string;
  error?: string;
};

export type ApplyStoreResult = {
  applied: AppliedAction[];
  changed: number;
  failed: number;
};

/**
 * Read the real store the agent is allowed to see, immediately before it answers. What is not in
 * here is not in the model's context, so the agent can never invent rows it was never shown.
 * Never throws: an unreadable store is reported as a snapshot with `project: null`.
 */
export async function readStoreSnapshot(
  supa: SupabaseClient,
  projectId: string | null
): Promise<AgentStoreSnapshot> {
  const empty: AgentStoreSnapshot = {
    project: null,
    characters: [],
    locations: [],
    episodes: [],
    scenes: [],
    taken_at: new Date().toISOString(),
  };
  if (!projectId) return empty;

  const { data: project } = await supa
    .from("projects")
    .select("id, slug, title, logline, story_bible")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) return empty;

  const [characters, locations, episodes] = await Promise.all([
    supa.from("characters").select("name, role, description").eq("project_id", projectId).order("created_at").limit(200),
    supa.from("locations").select("name, description").eq("project_id", projectId).order("created_at").limit(200),
    supa.from("episodes").select("id, number, title, status, concept").eq("project_id", projectId).order("number").limit(200),
  ]);

  const episodeRows = (episodes.data ?? []) as Array<{ id: string; number: number; title: string; status: string; concept: string | null }>;
  const numberById = new Map(episodeRows.map((e) => [e.id, e.number]));
  let scenes: AgentStoreSnapshot["scenes"] = [];
  if (episodeRows.length) {
    const { data } = await supa
      .from("scenes")
      .select("episode_id, index, title")
      .in("episode_id", episodeRows.map((e) => e.id))
      .order("index")
      .limit(500);
    scenes = ((data ?? []) as Array<{ episode_id: string; index: number; title: string | null }>)
      .filter((s) => numberById.has(s.episode_id))
      .map((s) => ({ episode_number: numberById.get(s.episode_id) as number, index: s.index, title: s.title }));
  }

  return {
    project: {
      id: String(project.id),
      slug: String(project.slug),
      title: String(project.title),
      logline: (project.logline as string | null) ?? null,
      story_bible: (project.story_bible as Record<string, unknown> | null) ?? {},
    },
    characters: (characters.data ?? []) as AgentStoreSnapshot["characters"],
    locations: (locations.data ?? []) as AgentStoreSnapshot["locations"],
    episodes: episodeRows.map((e) => ({ number: e.number, title: e.title, status: e.status, concept: e.concept })),
    scenes,
    taken_at: new Date().toISOString(),
  };
}

const EPISODE_STATUSES = [
  "idea", "writing", "scenes", "imaging", "voicing", "rendering",
  "qc", "ready_for_review", "approved", "uploading", "published", "archived",
] as const;

const PROJECT_FIELDS = ["title", "logline", "story_bible"] as const;
const CHARACTER_FIELDS = ["role", "description", "visual_ref"] as const;
const LOCATION_FIELDS = ["description", "visual_ref"] as const;
const EPISODE_FIELDS = ["title", "concept", "outline", "script", "narration", "status", "auto_publish"] as const;
const SCENE_FIELDS = ["title", "script_excerpt", "image_spec", "narration_segment", "duration_sec"] as const;

type ProjectRow = { id: string; slug: string; title: string };

function text(data: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = data[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function integer(data: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const v = data[key];
    if (typeof v === "number" && Number.isFinite(v) && Number.isInteger(v)) return v;
    if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  }
  return undefined;
}

function ok(op: string, entity: StoreEntity, ref: string, id: string, summary: string): AppliedAction {
  return { op, ok: true, entity, ref, id, summary };
}

function fail(op: string, entity: StoreEntity | null, summary: string, error: string): AppliedAction {
  return { op, ok: false, entity, ref: null, id: null, summary, error };
}

/** Pick only the allow-listed fields the store table has, keeping the database shape authoritative. */
function pick(data: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key in data && data[key] !== null) out[key] = data[key];
  return out;
}

async function resolveProject(
  supa: SupabaseClient,
  projectId: string | null,
  handle: string | undefined
): Promise<ProjectRow | { error: string }> {
  if (handle) {
    const bySlug = await supa.from("projects").select("id, slug, title").eq("slug", handle).maybeSingle();
    if (bySlug.data) return bySlug.data as ProjectRow;
    const byTitle = await supa.from("projects").select("id, slug, title").ilike("title", handle).limit(1).maybeSingle();
    if (byTitle.data) return byTitle.data as ProjectRow;
    return { error: `no project matches "${handle}"` };
  }
  if (!projectId) return { error: "this room has no project yet — create one first" };
  const { data } = await supa.from("projects").select("id, slug, title").eq("id", projectId).maybeSingle();
  if (!data) return { error: "the room's project no longer exists" };
  return data as ProjectRow;
}

async function createProject(
  supa: SupabaseClient,
  action: AgentAction
): Promise<{ result: AppliedAction; project?: ProjectRow }> {
  const title = text(action.data, "title", "name");
  if (!title) return { result: fail(action.op, "project", "create_project needs a title", "title is required") };
  const baseSlug = resolveProjectSlug(text(action.data, "slug"), title);
  if (!baseSlug) {
    return {
      result: fail(
        action.op,
        "project",
        "create_project needs a usable title",
        "could not derive a slug of at least two letters or numbers from that title"
      ),
    };
  }
  for (const slug of slugCandidates(baseSlug)) {
    const storyBible = action.data.story_bible;
    const { data, error } = await supa
      .from("projects")
      .insert({
        slug,
        title,
        logline: text(action.data, "logline") ?? null,
        story_bible: storyBible && typeof storyBible === "object" ? storyBible : {},
      })
      .select()
      .single();
    if (!error) {
      return {
        result: ok(action.op, "project", `project:${slug}`, String(data.id), `Created project "${title}" (${slug})`),
        // Subsequent actions in the same batch target the project the agent just created.
        project: { id: String(data.id), slug, title },
      };
    }
    const kind = classifySlugWriteError((error as { code?: string }).code);
    if (kind === "duplicate") continue;
    return { result: fail(action.op, "project", `create project "${title}"`, error.message) };
  }
  return { result: fail(action.op, "project", `create project "${title}"`, `could not allocate a unique slug for "${baseSlug}"`) };
}

/** Find a character/location row inside the project by its name. */
async function findByName(
  supa: SupabaseClient,
  table: "characters" | "locations",
  projectId: string,
  name: string
): Promise<{ id: string; name: string } | null> {
  const { data } = await supa
    .from(table)
    .select("id, name")
    .eq("project_id", projectId)
    .ilike("name", name)
    .limit(1)
    .maybeSingle();
  return (data as { id: string; name: string } | null) ?? null;
}

async function findEpisode(
  supa: SupabaseClient,
  projectId: string,
  number: number
): Promise<{ id: string; number: number } | null> {
  const { data } = await supa
    .from("episodes")
    .select("id, number")
    .eq("project_id", projectId)
    .eq("number", number)
    .maybeSingle();
  return (data as { id: string; number: number } | null) ?? null;
}

async function applyOne(
  supa: SupabaseClient,
  action: AgentAction,
  projectId: string | null
): Promise<{ result: AppliedAction; project?: ProjectRow }> {
  const op = action.op;

  if (op === "create_project") return await createProject(supa, action);

  const project = await resolveProject(supa, projectId, action.project);
  if ("error" in project) return { result: fail(op, null, `${op} — ${project.error}`, project.error) };

  switch (op) {
    case "update_project": {
      const title = text(action.data, "title");
      const patch = pick(action.data, PROJECT_FIELDS);
      delete patch["title"];
      if (title) patch["title"] = title;
      if (Object.keys(patch).length === 0) {
        return { result: fail(op, "project", "update_project had no known fields", "no updatable fields (title, logline, story_bible)") };
      }
      const { error } = await supa.from("projects").update(patch).eq("id", project.id);
      if (error) return { result: fail(op, "project", `update project ${project.title}`, error.message) };
      return {
        result: ok(op, "project", `project:${project.slug}`, project.id, `Updated project "${project.title}" (${Object.keys(patch).join(", ")})`),
        project,
      };
    }

    case "create_character": {
      const name = text(action.data, "name");
      if (!name) return { result: fail(op, "character", "create_character needs a name", "name is required") };
      const { data, error } = await supa
        .from("characters")
        .insert({
          project_id: project.id,
          name,
          role: text(action.data, "role") ?? null,
          description: text(action.data, "description") ?? null,
          visual_ref: text(action.data, "visual_ref") ?? null,
        })
        .select()
        .single();
      if (error) return { result: fail(op, "character", `create character ${name}`, error.message) };
      return { result: ok(op, "character", `character:${name}`, String(data.id), `Created character "${name}"`), project };
    }

    case "update_character":
    case "update_location": {
      const entity: StoreEntity = op === "update_character" ? "character" : "location";
      const table = op === "update_character" ? "characters" : "locations";
      const fields = op === "update_character" ? CHARACTER_FIELDS : LOCATION_FIELDS;
      const name = text(action.data, "name", "character", "location");
      if (!name) return { result: fail(op, entity, `${op} needs the existing name`, "name is required") };
      const found = await findByName(supa, table, project.id, name);
      if (!found) return { result: fail(op, entity, `${op} — ${name}`, `no ${entity} named "${name}" in ${project.title}`) };
      const patch = pick(action.data, fields);
      const newName = text(action.data, "new_name", "rename_to");
      if (newName) patch["name"] = newName;
      if (Object.keys(patch).length === 0) {
        return { result: fail(op, entity, `${op} — ${name}`, `no updatable fields (${fields.join(", ")})`) };
      }
      const { error } = await supa.from(table).update(patch).eq("id", found.id);
      if (error) return { result: fail(op, entity, `${op} — ${name}`, error.message) };
      const label = newName ?? found.name;
      return {
        result: ok(op, entity, `${entity}:${label}`, found.id, `Updated ${entity} "${found.name}" (${Object.keys(patch).join(", ")})`),
        project,
      };
    }

    case "create_location": {
      const name = text(action.data, "name");
      if (!name) return { result: fail(op, "location", "create_location needs a name", "name is required") };
      const { data, error } = await supa
        .from("locations")
        .insert({
          project_id: project.id,
          name,
          description: text(action.data, "description") ?? null,
          visual_ref: text(action.data, "visual_ref") ?? null,
        })
        .select()
        .single();
      if (error) return { result: fail(op, "location", `create location ${name}`, error.message) };
      return { result: ok(op, "location", `location:${name}`, String(data.id), `Created location "${name}"`), project };
    }

    case "create_episode": {
      const title = text(action.data, "title", "name");
      if (!title) return { result: fail(op, "episode", "create_episode needs a title", "title is required") };
      let number = integer(action.data, "number", "episode_number");
      if (number === undefined || number < 1) {
        const { data } = await supa
          .from("episodes")
          .select("number")
          .eq("project_id", project.id)
          .order("number", { ascending: false })
          .limit(1)
          .maybeSingle();
        number = ((data?.number as number | undefined) ?? 0) + 1;
      }
      const inserted = await supa
        .from("episodes")
        .insert({
          project_id: project.id,
          number,
          title,
          concept: text(action.data, "concept") ?? null,
          status: "idea",
        })
        .select()
        .single();
      if (inserted.error) return { result: fail(op, "episode", `create episode ${title}`, inserted.error.message) };
      return {
        result: ok(op, "episode", `episode:${number}`, String(inserted.data.id), `Created EP ${number} "${title}"`),
        project,
      };
    }

    case "update_episode": {
      const number = integer(action.data, "number", "episode_number", "episode");
      if (number === undefined) return { result: fail(op, "episode", "update_episode needs the episode number", "number is required") };
      const found = await findEpisode(supa, project.id, number);
      if (!found) return { result: fail(op, "episode", `episode:${number}`, `no EP ${number} in ${project.title}`) };
      const patch = pick(action.data, EPISODE_FIELDS);
      if (typeof patch["status"] === "string" && !EPISODE_STATUSES.includes(patch["status"] as (typeof EPISODE_STATUSES)[number])) {
        return { result: fail(op, "episode", `episode:${number}`, `invalid status "${patch["status"]}"`) };
      }
      if (Object.keys(patch).length === 0) {
        return { result: fail(op, "episode", `episode:${number}`, `no updatable fields (${EPISODE_FIELDS.join(", ")})`) };
      }
      const { error } = await supa.from("episodes").update(patch).eq("id", found.id);
      if (error) return { result: fail(op, "episode", `episode:${number}`, error.message) };
      return {
        result: ok(op, "episode", `episode:${number}`, found.id, `Updated EP ${number} (${Object.keys(patch).join(", ")})`),
        project,
      };
    }

    case "create_scene": {
      const episodeNumber = integer(action.data, "episode_number", "episode", "number");
      if (episodeNumber === undefined) {
        return { result: fail(op, "scene", "create_scene needs episode_number", "episode_number is required") };
      }
      const episode = await findEpisode(supa, project.id, episodeNumber);
      if (!episode) return { result: fail(op, "scene", `EP ${episodeNumber}`, `no EP ${episodeNumber} in ${project.title}`) };
      const last = await supa
        .from("scenes")
        .select("index")
        .eq("episode_id", episode.id)
        .order("index", { ascending: false })
        .limit(1)
        .maybeSingle();
      const index = ((last.data?.index as number | undefined) ?? -1) + 1;
      const { data, error } = await supa
        .from("scenes")
        .insert({
          episode_id: episode.id,
          index,
          title: text(action.data, "title") ?? null,
          script_excerpt: text(action.data, "script_excerpt") ?? null,
          image_spec: text(action.data, "image_spec") ?? null,
          narration_segment: text(action.data, "narration_segment") ?? null,
          duration_sec: typeof action.data["duration_sec"] === "number" ? action.data["duration_sec"] : null,
        })
        .select()
        .single();
      if (error) return { result: fail(op, "scene", `EP ${episodeNumber} scene`, error.message) };
      return {
        result: ok(op, "scene", `scene:EP${episodeNumber}#${index}`, String(data.id), `Added scene ${index} to EP ${episodeNumber}`),
        project,
      };
    }

    case "update_scene": {
      const episodeNumber = integer(action.data, "episode_number", "episode", "number");
      const index = integer(action.data, "index", "scene_index");
      if (episodeNumber === undefined || index === undefined) {
        return { result: fail(op, "scene", "update_scene needs episode_number and index", "episode_number and index are required") };
      }
      const episode = await findEpisode(supa, project.id, episodeNumber);
      if (!episode) return { result: fail(op, "scene", `EP ${episodeNumber}`, `no EP ${episodeNumber} in ${project.title}`) };
      const { data: scene } = await supa
        .from("scenes")
        .select("id")
        .eq("episode_id", episode.id)
        .eq("index", index)
        .maybeSingle();
      if (!scene) return { result: fail(op, "scene", `EP ${episodeNumber} #${index}`, `no scene ${index} in EP ${episodeNumber}`) };
      const patch = pick(action.data, SCENE_FIELDS);
      if (Object.keys(patch).length === 0) {
        return { result: fail(op, "scene", `EP ${episodeNumber} #${index}`, `no updatable fields (${SCENE_FIELDS.join(", ")})`) };
      }
      const { error } = await supa.from("scenes").update(patch).eq("id", scene.id);
      if (error) return { result: fail(op, "scene", `EP ${episodeNumber} #${index}`, error.message) };
      return {
        result: ok(op, "scene", `scene:EP${episodeNumber}#${index}`, String(scene.id), `Updated EP ${episodeNumber} scene ${index} (${Object.keys(patch).join(", ")})`),
        project,
      };
    }

    default:
      return { result: fail(op, null, `${op} is not supported`, "unsupported operation") };
  }
}

/**
 * Apply a batch in order. A newly created project becomes the working project for the rest of the
 * batch, so "create a project and seed its cast" works in one turn.
 */
export async function applyStoreActions(
  supa: SupabaseClient,
  actions: AgentAction[],
  defaultProjectId: string | null,
  actor = "agent:script"
): Promise<ApplyStoreResult> {
  const applied: AppliedAction[] = [];
  let workingProjectId = defaultProjectId;

  for (const action of actions) {
    let result: AppliedAction;
    try {
      const outcome = await applyOne(supa, action, workingProjectId);
      result = outcome.result;
      if (outcome.project && action.op === "create_project") workingProjectId = outcome.project.id;
    } catch (e) {
      result = fail(action.op, null, `${action.op} failed`, e instanceof Error ? e.message : String(e));
    }
    applied.push(result);
    if (result.ok) {
      // Auditable: every store change the agent made is a row in `events` (CONSTRAINTS.md #20).
      try {
        await supa.from("events").insert({
          type: "agent.store_change",
          project_id: workingProjectId,
          actor,
          payload: { op: result.op, entity: result.entity, ref: result.ref, id: result.id, summary: result.summary },
        });
      } catch {
        /* the audit row is best-effort; the write itself already happened and is reported */
      }
    }
  }

  const changed = applied.filter((a) => a.ok).length;
  return { applied, changed, failed: applied.length - changed };
}
