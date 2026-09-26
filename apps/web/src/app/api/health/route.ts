import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Vercel frontend must NOT own Supabase secrets. Real health lives on Render (NEXT_PUBLIC_API_URL).
// This shim keeps local dev usable when the Render API is not running yet.
export async function GET() {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");
  if (apiUrl) {
    try {
      const r = await fetch(`${apiUrl}/api/health`, { cache: "no-store" });
      const j = await r.json();
      return NextResponse.json({ ...j, proxiedFrom: apiUrl }, { status: r.status });
    } catch (e) {
      return NextResponse.json(
        {
          ok: false,
          app: "ostra-web",
          host: "vercel",
          error: `Render API unreachable at ${apiUrl}`,
          reason: e instanceof Error ? e.message : String(e),
          hint: "Set NEXT_PUBLIC_API_URL to your Render API URL (e.g. https://ostra-api.onrender.com). Render must own SUPABASE_* and worker env vars.",
        },
        { status: 502 }
      );
    }
  }
  // Local offline fallback — no mocks, just truthful OFFLINE states
  return NextResponse.json({
    ok: true,
    app: "ostra-web",
    host: "vercel (local)",
    at: new Date().toISOString(),
    autoPublish: false,
    supabase: "not_configured",
    note: "Set NEXT_PUBLIC_API_URL to your Render API to proxy real health. Until then this is local OFFLINE truth.",
    providers: {
      script: { ok: false, status: "OFFLINE", reason: "Render API not configured (NEXT_PUBLIC_API_URL missing)" },
      image: { ok: false, status: "OFFLINE", reason: "Render API not configured" },
      voice: { ok: false, status: "OFFLINE", reason: "Render API not configured" },
      video: { ok: false, status: "OFFLINE", reason: "Render API not configured — FFmpeg is independently replaceable" },
      storage: { ok: false, status: "OFFLINE", reason: "Render owns Supabase Storage" },
      youtube: { ok: false, status: "OFFLINE", reason: "Render owns YouTube OAuth" },
    },
  });
}
