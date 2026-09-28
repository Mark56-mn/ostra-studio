import cors from "cors";
import { isOriginAllowed, resolveAllowedOrigins } from "@ostra/shared";

// The production frontend origin (https://ostra-studio-web.vercel.app), Vercel previews and
// localhost are always allowed. Additional origins come from CORS_ORIGINS / WEB_ORIGIN.
// `*` is never used — worker registration/heartbeat are token-protected.
const allowed = resolveAllowedOrigins({
  CORS_ORIGINS: process.env.CORS_ORIGINS,
  WEB_ORIGIN: process.env.WEB_ORIGIN,
});

export const corsMiddleware = cors({
  origin(origin, cb) {
    if (isOriginAllowed(origin, allowed)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: false,
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-worker-token", "x-cron-secret"],
});
