import type { Request, Response } from "express";
import { requireSupabase } from "../lib/supabase.js";

export async function listApprovals(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const episodeId = (req.query.episodeId as string) ?? null;
  let q = supa.from("approvals").select("*").order("created_at", { ascending: false });
  if (episodeId) q = q.eq("episode_id", episodeId);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ approvals: data ?? [] });
}

export async function createApproval(req: Request, res: Response) {
  const supa = requireSupabase(res);
  if (!supa) return;
  const body = req.body as { episode_id?: string; decision?: string; note?: string; requested_by?: string; decided_by?: string } | null;
  if (!body?.episode_id) return res.status(400).json({ error: "episode_id is required" });
  const decision = body.decision ?? "pending";
  if (!["pending","approved","rejected","changes_requested"].includes(decision)) return res.status(400).json({ error: "invalid decision" });
  const row: Record<string, unknown> = {
    episode_id: body.episode_id, decision, note: body.note ?? null,
    requested_by: body.requested_by ?? null, decided_by: body.decided_by ?? null,
  };
  if (decision !== "pending") row["decided_at"] = new Date().toISOString();
  const { data, error } = await supa.from("approvals").insert(row).select().single();
  if (error) return res.status(400).json({ error: error.message });
  const eventType = decision === "approved" ? "approval.granted" : decision === "rejected" ? "approval.rejected" : decision === "changes_requested" ? "approval.rejected" : "approval.requested";
  await supa.from("events").insert({ type: eventType, episode_id: body.episode_id, actor: body.decided_by ?? body.requested_by ?? "human", payload: { decision, note: body.note ?? null } });
  if (decision === "approved") {
    await supa.from("episodes").update({ status: "approved" }).eq("id", body.episode_id).eq("status", "ready_for_review");
  }
  res.status(201).json({ approval: data });
}
