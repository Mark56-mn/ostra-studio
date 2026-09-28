import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// The Vercel frontend must NOT own Supabase secrets. Real health lives on Render (NEXT_PUBLIC_API_URL).
// This shim exists for local development and never fabricates provider states.
export async function GET() {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/+$/, "");
  const timestamp = new Date().toISOString();

  if (apiUrl) {
    try {
      const r = await fetch(`${apiUrl}/api/health`, { cache: "no-store" });
      const j = await r.json();
      return NextResponse.json({ ...j, proxiedFrom: apiUrl }, { status: r.status });
    } catch (e) {
      return NextResponse.json(
        {
          ok: false,
          status: "ERROR",
          app: "ostra-web",
          host: "vercel",
          reason: `Render API unreachable at ${apiUrl}`,
          error: e instanceof Error ? e.message : String(e),
          supabase: {
            ok: false,
            status: "UNKNOWN",
            provider: "supabase",
            reason: "Render API unreachable — Supabase state cannot be verified",
            checkedAt: timestamp,
          },
          providers: {},
          timestamp,
          at: timestamp,
        },
        { status: 502 }
      );
    }
  }

  // Local dev with no Render API configured: say exactly that. No fake providers.
  return NextResponse.json({
    ok: false,
    status: "DEGRADED",
    app: "ostra-web",
    host: "local",
    autoPublish: false,
    reason:
      "NEXT_PUBLIC_API_URL is not set. This Next dev server is not the backend — start the Render API (or set the env var) to see real state.",
    supabase: {
      ok: false,
      status: "NOT_CONFIGURED",
      provider: "supabase",
      reason: "Backend not configured (NEXT_PUBLIC_API_URL missing)",
      checkedAt: timestamp,
    },
    providers: {},
    timestamp,
    at: timestamp,
  });
}
