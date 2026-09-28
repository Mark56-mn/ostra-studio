# ── Ostra Studio worker bootstrap (managed cell) ──
# This cell is required for Script AI to reach ONLINE. It is the ONLY thing that tells the
# Ostra backend this Kaggle runtime exists, where to reach it, and that it is still alive.
#
# It is honest by construction: if the registration token is missing, or the backend rejects
# the call, it says so and never pretends the worker is online.
#
# Config (Kaggle > Add-ons > Secrets):
#   WORKER_REGISTRATION_TOKEN  (required)  must equal WORKER_REGISTRATION_TOKEN on the backend
#   OSTRA_API_URL              (optional)  defaults to DEFAULT_API_URL below
#
# Managed by scripts/kaggle-sync-notebook.ts — edit scripts/kaggle-worker-bootstrap.py, not here.

import json
import os
import threading
import time

import requests

DEFAULT_API_URL = "https://ostra-studio-1.onrender.com"
HEARTBEAT_SECONDS = 30

try:
    from kaggle_secrets import UserSecretsClient

    _secrets = UserSecretsClient()

    def _secret(name):
        try:
            return _secrets.get_secret(name)
        except Exception:
            return os.environ.get(name)
except Exception:  # not running on Kaggle
    def _secret(name):
        return os.environ.get(name)


API_URL = (_secret("OSTRA_API_URL") or DEFAULT_API_URL).rstrip("/")
TOKEN = (_secret("WORKER_REGISTRATION_TOKEN") or _secret("WORKER_REGISTRATION_SECRET") or "").strip()
ENDPOINT = globals().get("PUBLIC_URL") or None

WORKER = {
    "worker_id": "script-ai-kaggle",
    "worker_type": "script",
    "runtime": "kaggle",
    "provider": "kaggle",
    "model": "Qwen/Qwen3-1.7B",
    "capabilities": [
        "story_development",
        "script_writing",
        "scene_planning",
        "dialogue",
        "narration_text",
        "image_prompts",
        "story_continuity",
    ],
    "status": "ONLINE",
}


def _post(path, payload):
    """POST to the Ostra API. Returns (status_code, body_text); raises only on transport errors."""
    response = requests.post(
        API_URL + path,
        headers={"Content-Type": "application/json", "x-worker-token": TOKEN},
        data=json.dumps(payload),
        timeout=20,
    )
    return response.status_code, response.text


def _register():
    payload = dict(WORKER)
    payload["endpoint"] = ENDPOINT
    payload["metadata"] = {"kernel": "bettertrade/notebook7eae283a4a", "runtime_note": "kaggle notebook"}
    return _post("/api/workers/register", payload)


if not TOKEN:
    print("[ostra] NOT REGISTERED — Script AI stays OFFLINE.")
    print("[ostra] Missing Kaggle secret WORKER_REGISTRATION_TOKEN (must match the backend value).")
else:
    print(f"[ostra] registering {WORKER['worker_id']} with {API_URL}")
    print(f"[ostra] endpoint={ENDPOINT or '(no tunnel URL — PUBLIC_URL not set)'}")
    try:
        status, body = _register()
        print(f"[ostra] register -> HTTP {status} {body[:300]}")
    except Exception as exc:  # transport failure, not a fake success
        status = None
        print(f"[ostra] register FAILED: {exc}")

    def _heartbeat_loop():
        while True:
            time.sleep(HEARTBEAT_SECONDS)
            try:
                code, text = _post("/api/workers/heartbeat", dict(WORKER))
                if code == 404:
                    # Backend forgot us (restart, sweep, DB reset) — register again rather than go dark.
                    print("[ostra] heartbeat 404 — re-registering")
                    code, text = _register()
                print(f"[ostra] heartbeat -> HTTP {code}")
            except Exception as exc:
                print(f"[ostra] heartbeat FAILED: {exc}")

    if status is not None and 200 <= status < 300:
        threading.Thread(target=_heartbeat_loop, daemon=True).start()
        print(f"[ostra] heartbeat loop started every {HEARTBEAT_SECONDS}s — ONLINE until heartbeats stop")
    else:
        print("[ostra] heartbeat NOT started because registration did not succeed.")
