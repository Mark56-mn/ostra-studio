# ── Ostra Studio worker bootstrap (managed cell) ──
# This cell is required for Script AI to reach ONLINE. It is the ONLY thing that tells the
# Ostra backend this Kaggle runtime exists, where to reach it, and that it is still alive.
#
# It is honest by construction: it reports the real HTTP status of every call it makes and never
# claims to be online when it is not.
#
#   1. GET {PUBLIC_URL}/health  — verifies the public tunnel itself, from inside the notebook.
#   2. POST /api/workers/register — the actual registration.
#   3. POST /api/workers/heartbeat every 30s.
#
# A token is NOT required locally. The backend only demands one when WORKER_REGISTRATION_TOKEN /
# WORKER_REGISTRATION_SECRET is configured on Render; when it is, we send whatever we have and a
# 401 is reported as "backend requires a matching token" instead of a silent failure.
#
# Everything learned is written to ostra-status.json / ostra-bootstrap.log in the working
# directory, because a Kaggle version only publishes output files when the run ends.
#
# Config (Kaggle > Add-ons > Secrets):
#   WORKER_REGISTRATION_TOKEN  (required only if Render sets it)  must match the backend value
#   OSTRA_API_URL              (optional)  defaults to DEFAULT_API_URL below
#   OSTRA_KEEPALIVE_MINUTES    (optional)  how long to hold the runtime open (default 10)
#
# Managed by scripts/kaggle-sync-notebook.ts — edit scripts/kaggle-worker-bootstrap.py, not here.

import json
import os
import threading
import time

import requests

DEFAULT_API_URL = "https://ostra-studio-1.onrender.com"
HEARTBEAT_SECONDS = 30
DEFAULT_KEEPALIVE_MINUTES = 10
STATUS_PATH = "ostra-status.json"
LOG_PATH = "ostra-bootstrap.log"

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
    # Report the model actually booted (the model load cell resolves MODEL_ID before this cell
    # runs). "unknown" means no model cell ran — never claim a model that is not really serving.
    "model": (globals().get("MODEL_ID") or "unknown"),
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

STATUS = {
    "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "api_url": API_URL,
    "endpoint": ENDPOINT,
    "worker_id": WORKER["worker_id"],
    "model": WORKER["model"],
    "token_present": bool(TOKEN),
    "tunnel_health": None,
    "register": None,
    "heartbeats": [],
    "keepalive_minutes": None,
    "finished_at": None,
}


def _log(message):
    """Print AND persist a line, so the record survives the kernel (Kaggle publishes it at end)."""
    print(message, flush=True)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(message + "\n")
    except Exception:
        pass


def _write_status():
    try:
        with open(STATUS_PATH, "w", encoding="utf-8") as fh:
            json.dump(STATUS, fh, indent=2, sort_keys=True)
    except Exception:
        pass


def _post(path, payload):
    """POST to the Ostra API. Returns (status_code, body_text); raises only on transport errors."""
    response = requests.post(
        API_URL + path,
        headers={"Content-Type": "application/json", "x-worker-token": TOKEN},
        data=json.dumps(payload),
        timeout=20,
    )
    return response.status_code, response.text


def _tunnel_check():
    """GET our own public /health. Records the real HTTP status so \"is the URL up?\" has an answer."""
    if not ENDPOINT:
        STATUS["tunnel_health"] = {"checked": False, "reason": "PUBLIC_URL not set (ngrok tunnel not established)"}
        _write_status()
        _log("[ostra] tunnel check SKIPPED — no PUBLIC_URL (the ngrok tunnel was not established)")
        return STATUS["tunnel_health"]
    url = ENDPOINT.rstrip("/") + "/health"
    try:
        r = requests.get(url, headers={"ngrok-skip-browser-warning": "1"}, timeout=20)
        result = {"checked": True, "url": url, "http_status": r.status_code, "ok": r.status_code == 200, "body": r.text[:200]}
        _log(f"[ostra] tunnel check {url} -> HTTP {r.status_code}")
    except Exception as exc:
        result = {"checked": True, "url": url, "ok": False, "error": str(exc)}
        _log(f"[ostra] tunnel check {url} FAILED: {exc}")
    STATUS["tunnel_health"] = result
    _write_status()
    return result


def _register():
    payload = dict(WORKER)
    payload["endpoint"] = ENDPOINT
    payload["metadata"] = {
        "kernel": "bettertrade/notebook7eae283a4a",
        "runtime_note": "kaggle notebook",
        "tunnel_health": STATUS["tunnel_health"],
    }
    return _post("/api/workers/register", payload)


_log(f"[ostra] worker_id={WORKER['worker_id']} -> {API_URL}")
_log(f"[ostra] endpoint={ENDPOINT or '(no tunnel URL — PUBLIC_URL not set)'}")
_log(f"[ostra] registration token locally: {'set' if TOKEN else 'NOT set'}")
_log(f"[ostra] model={WORKER['model']}")

# 1) Prove the public tunnel before claiming anything about the worker.
_tunnel_check()

# 2) Register. We always attempt it: the backend permits registration without a token when it has
#    none configured, and answers 401 when it requires one we do not have. Either answer is real.
try:
    status, body = _register()
    _log(f"[ostra] register -> HTTP {status} {body[:300]}")
    STATUS["register"] = {"http_status": status, "ok": 200 <= status < 300, "body": body[:300]}
    if status == 401:
        _log("[ostra] the backend requires a registration token — add the Kaggle secret "
             "WORKER_REGISTRATION_TOKEN with the same value Render holds")
        STATUS["register"]["hint"] = "add Kaggle secret WORKER_REGISTRATION_TOKEN matching Render"
except Exception as exc:  # transport failure, not a fake success
    status = None
    _log(f"[ostra] register FAILED: {exc}")
    STATUS["register"] = {"ok": False, "error": str(exc)}
_write_status()

if status is None or not (200 <= status < 300):
    _log("[ostra] NOT REGISTERED — Script AI stays OFFLINE.")
else:
    def _heartbeat_loop():
        while True:
            time.sleep(HEARTBEAT_SECONDS)
            try:
                code, text = _post("/api/workers/heartbeat", dict(WORKER))
                if code == 404:
                    # Backend forgot us (restart, sweep, DB reset) — register again rather than go dark.
                    _log("[ostra] heartbeat 404 — re-registering")
                    code, text = _register()
                if len(STATUS["heartbeats"]) < 50:
                    STATUS["heartbeats"].append({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "http_status": code})
                    _write_status()
                _log(f"[ostra] heartbeat -> HTTP {code}")
            except Exception as exc:
                _log(f"[ostra] heartbeat FAILED: {exc}")

    threading.Thread(target=_heartbeat_loop, daemon=True).start()
    _log(f"[ostra] heartbeat loop started every {HEARTBEAT_SECONDS}s — ONLINE until heartbeats stop")

    # A Kaggle batch run ends when its last cell returns, which would kill the heartbeat thread and
    # drop the worker back to OFFLINE within the timeout. Hold the runtime open for a bounded window
    # so Script AI is genuinely ONLINE, then end cleanly so this version publishes its outputs.
    try:
        keepalive_minutes = int(_secret("OSTRA_KEEPALIVE_MINUTES") or DEFAULT_KEEPALIVE_MINUTES)
    except (TypeError, ValueError):
        keepalive_minutes = DEFAULT_KEEPALIVE_MINUTES
    keepalive_minutes = max(0, min(keepalive_minutes, 720))
    STATUS["keepalive_minutes"] = keepalive_minutes
    _write_status()
    if keepalive_minutes:
        _log(f"[ostra] holding the runtime open for {keepalive_minutes} min so heartbeats keep it ONLINE")
        deadline = time.time() + keepalive_minutes * 60
        while time.time() < deadline:
            time.sleep(5)
        _log("[ostra] keep-alive window elapsed — this run is ending (worker will go OFFLINE)")

STATUS["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
_write_status()
