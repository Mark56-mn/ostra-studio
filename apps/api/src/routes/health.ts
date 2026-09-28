import type { Request, Response } from "express";
import { buildHealthReport } from "../lib/providerHealth.js";

// GET /health and GET /api/health — identical contract.
// `ok` is only true when the backend can actually persist (Supabase ONLINE) and no provider is
// in ERROR. Provider configuration alone never yields ok:true.
export async function healthHandler(_req: Request, res: Response) {
  try {
    const report = await buildHealthReport();
    res.json(report);
  } catch (e) {
    // Backend answered, but the report failed. Report that truthfully (HTTP 200 so the dashboard
    // can distinguish "degraded backend" from "backend unreachable").
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
        reason: "health report failed before Supabase could be checked",
        checkedAt: timestamp,
      },
      providers: {},
      timestamp,
      at: timestamp,
    });
  }
}
