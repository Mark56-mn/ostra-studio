import type { Request, Response } from "express";
import { collectProvidersFlat } from "../lib/providerHealth.js";

export async function providersHandler(_req: Request, res: Response) {
  const out = await collectProvidersFlat();
  res.json(out);
}
