import type { Request, Response } from "express";
import { buildHealthReport } from "../lib/providerHealth.js";

// GET /api/providers — same contract as /api/health so the dashboard only needs one parser.
export async function providersHandler(_req: Request, res: Response) {
  try {
    const report = await buildHealthReport();
    res.json(report);
  } catch (e) {
    const timestamp = new Date().toISOString();
    res.json({
      ok: false,
      status: "ERROR" as const,
      app: "ostra-api",
      host: process.env.OSTRA_HOST ?? "render",
      autoPublish: process.env.AUTO_PUBLISH === "true",
      reason: e instanceof Error ? e.message : String(e),
      supabase: {
        ok: false,
        status: "UNKNOWN" as const,
        provider: "supabase",
        reason: "provider report failed before Supabase could be checked",
        checkedAt: timestamp,
      },
      providers: {},
      timestamp,
      at: timestamp,
    });
  }
}
