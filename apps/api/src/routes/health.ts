import type { Request, Response } from "express";
import { isSupabaseConfigured } from "../lib/supabase.js";
import { collectProviderHealth } from "../lib/providerHealth.js";

export async function healthHandler(_req: Request, res: Response) {
  const providers = await collectProviderHealth();
  res.json({
    ok: true,
    at: new Date().toISOString(),
    app: "ostra-api",
    host: "render",
    autoPublish: process.env.AUTO_PUBLISH === "true",
    supabase: isSupabaseConfigured() ? "configured" : "not_configured",
    providers,
  });
}
