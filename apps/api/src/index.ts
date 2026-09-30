import express from "express";
import { corsMiddleware } from "./lib/cors.js";
import { healthHandler } from "./routes/health.js";
import { providersHandler } from "./routes/providers.js";
import { listProjects, createProject, getProject, patchProject } from "./routes/projects.js";
import { listEpisodes, createEpisode, getEpisode, patchEpisode } from "./routes/episodes.js";
import { listScenes, createScene, patchScene, deleteScene } from "./routes/scenes.js";
import { listTasks, createTask, patchTask } from "./routes/tasks.js";
import { listEvents, createEvent } from "./routes/events.js";
import { listApprovals, createApproval } from "./routes/approvals.js";
import { listWorkers, createWorker, patchWorker, heartbeatWorker } from "./routes/workers.js";
import { registerWorker, heartbeatByIdentity } from "./routes/registration.js";
import { listModels, setModelEnabled } from "./routes/models.js";
import { listCharacters, createCharacter, patchCharacter, deleteCharacter } from "./routes/characters.js";
import { listLocations, createLocation, patchLocation, deleteLocation } from "./routes/locations.js";
import { listArtifacts, createArtifact } from "./routes/artifacts.js";
import { listSchedules, createSchedule, getSchedule, patchSchedule, deleteSchedule, seedDefaultSchedules } from "./routes/schedules.js";
import { schedulerTickHandler, runNowHandler, listStartupHistory } from "./routes/runtime.js";
import { listRooms, createRoom, patchRoom, listMessages, postMessage, getStore } from "./routes/chat.js";
import {
  getRoster,
  listStudioRooms,
  createStudioRoom,
  patchStudioRoom,
  listChannelMessages,
  dispatchRound,
} from "./routes/agents.js";

const app = express();
app.use(corsMiddleware);
app.use(express.json({ limit: "2mb" }));

// Health — no auth, no DB required to return provider truth
app.get("/health", healthHandler);
app.get("/api/health", healthHandler);
app.get("/api/providers", providersHandler);

// Projects
app.get("/api/projects", listProjects);
app.post("/api/projects", createProject);
app.get("/api/projects/:id", getProject);
app.patch("/api/projects/:id", patchProject);

// Characters / Locations (project-scoped)
app.get("/api/characters", listCharacters);
app.post("/api/characters", createCharacter);
app.patch("/api/characters/:id", patchCharacter);
app.delete("/api/characters/:id", deleteCharacter);
app.get("/api/locations", listLocations);
app.post("/api/locations", createLocation);
app.patch("/api/locations/:id", patchLocation);
app.delete("/api/locations/:id", deleteLocation);

// Episodes
app.get("/api/episodes", listEpisodes);
app.post("/api/episodes", createEpisode);
app.get("/api/episodes/:id", getEpisode);
app.patch("/api/episodes/:id", patchEpisode);

// Scenes
app.get("/api/scenes", listScenes);
app.post("/api/scenes", createScene);
app.patch("/api/scenes/:id", patchScene);
app.delete("/api/scenes/:id", deleteScene);

// Tasks (orchestrator-owned)
app.get("/api/tasks", listTasks);
app.post("/api/tasks", createTask);
app.patch("/api/tasks/:id", patchTask);

// Events (audit)
app.get("/api/events", listEvents);
app.post("/api/events", createEvent);

// Approvals (human gate, AUTO_PUBLISH=false by default)
app.get("/api/approvals", listApprovals);
app.post("/api/approvals", createApproval);

// Workers (registry + heartbeat + self-registration)
app.get("/api/workers", listWorkers);
app.post("/api/workers", createWorker);
app.patch("/api/workers/:id", patchWorker);
app.post("/api/workers/:id/heartbeat", heartbeatWorker);
app.post("/api/workers/register", registerWorker);
app.post("/api/workers/heartbeat", heartbeatByIdentity);

// AI model switches — operator on/off intent, merged with real provider health
app.get("/api/models", listModels);
app.patch("/api/models/:key", setModelEnabled);

// Runtime schedules — persisted, editable, timezone-aware
app.get("/api/runtime/schedules", listSchedules);
app.post("/api/runtime/schedules", createSchedule);
app.get("/api/runtime/schedules/:id", getSchedule);
app.patch("/api/runtime/schedules/:id", patchSchedule);
app.delete("/api/runtime/schedules/:id", deleteSchedule);
app.post("/api/runtime/schedules/seed", seedDefaultSchedules);

// Runtime supervisor — scheduler + Run Now (same lifecycle) + history
app.post("/api/runtime/tick", schedulerTickHandler);
app.post("/api/runtime/run-now", runNowHandler);
app.get("/api/runtime/history", listStartupHistory);

// Artifacts (versioned, never destructive)
app.get("/api/artifacts", listArtifacts);
app.post("/api/artifacts", createArtifact);

// Agent Chat — talk to the Script AI and let it adjust the real store
app.get("/api/chat/rooms", listRooms);
app.post("/api/chat/rooms", createRoom);
app.patch("/api/chat/rooms/:id", patchRoom);
app.get("/api/chat/rooms/:id/messages", listMessages);
app.post("/api/chat/rooms/:id/messages", postMessage);
app.get("/api/chat/store", getStore);

// AI Studio — agents talking to each other, with the Showrunner reporting to the director
app.get("/api/agents/roster", getRoster);
app.get("/api/agents/rooms", listStudioRooms);
app.post("/api/agents/rooms", createStudioRoom);
app.patch("/api/agents/rooms/:id", patchStudioRoom);
app.get("/api/agents/rooms/:id/messages", listChannelMessages);
app.post("/api/agents/rooms/:id/dispatch", dispatchRound);

// 404
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// Error handler
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("CORS blocked")) return res.status(403).json({ error: msg });
  console.error("[api] unhandled", err);
  res.status(500).json({ error: "Internal error" });
});

const port = Number(process.env.PORT ?? 3001);
app.listen(port, "0.0.0.0", () => {
  console.log(`[ostra-api] listening on 0.0.0.0:${port}  autoPublish=${process.env.AUTO_PUBLISH ?? "false"}  supabase=${process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL ? "configured" : "not_configured"}`);
});

// ── In-process scheduler tick (Render) ─────────────────────────────────────
// Fires every SCHEDULER_TICK_MS (default 60s). On Render, the preferred trigger
// is an external Cron (Render Cron / uptime ping) hitting POST /api/runtime/tick
// with x-cron-secret, so startup is not tied to process lifetime.
// The internal interval is kept as a fallback + for local dev.
const tickMs = Math.max(15_000, parseInt(process.env.SCHEDULER_TICK_MS ?? "60000", 10) || 60_000);
const schedulerEnabled = (process.env.SCHEDULER_ENABLED ?? "true").toLowerCase() !== "false";

if (schedulerEnabled) {
  const tick = async () => {
    try {
      const { getServerSupabase } = await import("./lib/supabase.js");
      const supa = getServerSupabase();
      if (!supa) return;
      const { schedulerTick } = await import("./lib/scheduler.js");
      await schedulerTick(supa, new Date());
    } catch (e) {
      console.error("[ostra-api] scheduler tick failed", e);
    }
  };
  // First tick shortly after boot, then on interval. No tick when Supabase not configured.
  setTimeout(tick, 5_000);
  setInterval(tick, tickMs);
  console.log(`[ostra-api] scheduler enabled, interval=${tickMs}ms (also accepts POST /api/runtime/tick)`);
} else {
  console.log("[ostra-api] scheduler disabled (SCHEDULER_ENABLED=false)");
}
