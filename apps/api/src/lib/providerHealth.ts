import { resolveRegistry } from "@ostra/shared";

export async function collectProviderHealth() {
  const registry = resolveRegistry();
  const entries = await Promise.all(
    (Object.entries(registry) as Array<[string, { health: () => Promise<unknown>; providerName: string; id: string }]>).map(
      async ([k, p]) => {
        try {
          const h = await p.health();
          return [k, { provider: p.providerName, id: p.id, health: h }] as const;
        } catch (e) {
          return [k, { provider: p.providerName, id: p.id, health: { ok: false, status: "OFFLINE", reason: e instanceof Error ? e.message : String(e), checkedAt: new Date().toISOString() } }] as const;
        }
      }
    )
  );
  return Object.fromEntries(entries);
}

export async function collectProvidersFlat() {
  const registry = resolveRegistry();
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(registry) as Array<[string, { health: () => Promise<unknown>; providerName: string; id: string }]>) {
    try {
      out[k] = { provider: p.providerName, id: p.id, health: await p.health() };
    } catch (e) {
      out[k] = { provider: p.providerName, id: p.id, health: { ok: false, status: "OFFLINE", reason: String(e) } };
    }
  }
  return out;
}
