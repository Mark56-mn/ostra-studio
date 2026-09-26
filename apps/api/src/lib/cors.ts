import cors from "cors";

const allowed = (process.env.CORS_ORIGINS ?? process.env.WEB_ORIGIN ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// In dev / preview, allow all origins so Vercel preview deploys work.
// In production, set CORS_ORIGINS to a comma-separated allowlist.
export const corsMiddleware = cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowed.length === 0) return cb(null, true);
    if (allowed.includes(origin)) return cb(null, true);
    // allow vercel preview domains when the allowlist contains vercel.app
    if (allowed.some((a) => a.includes("vercel.app") && origin.endsWith(".vercel.app"))) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: false,
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-worker-token", "x-cron-secret"],
});
