# Web (Vercel) env — `apps/web`

Only `NEXT_PUBLIC_*` is browser-visible. Never put secrets here.

```
NEXT_PUBLIC_API_URL=https://your-render-api.onrender.com
NEXT_PUBLIC_APP_NAME=Ostra Studio
```

Leave `NEXT_PUBLIC_API_URL` empty in local dev to use the same-origin shim (offline truth, no secrets).
