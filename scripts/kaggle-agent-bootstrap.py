# ── Ostra Studio agent worker bootstrap (managed cell) ──
# The SAME cell is used by every non-script agent notebook (Image AI, Voice AI, Showrunner). It is
# required for the agent to reach ONLINE: it is the only thing that tells the Ostra backend this
# Kaggle runtime exists, where to reach it, and that it is still alive.
#
# Managed by scripts/kaggle-agent-notebook.ts — edit scripts/kaggle-agent-bootstrap.py, not here. That
# script replaces ONLY the OSTRA_AGENT line below with the agent this notebook serves.
#
# It is honest by construction: it reports the real HTTP status of every call it makes and never
# claims to be online when it is not.
#
#   1. GET {PUBLIC_URL}/health  — verifies the public tunnel AND the local model server behind it.
#   2. POST /api/workers/register — the actual registration.
#   3. POST /api/workers/heartbeat every 30s.
#
# A token is NOT required locally. The backend only demands one when WORKER_REGISTRATION_TOKEN /
# WORKER_REGISTRATION_SECRET is configured on Render; when it is, we send whatever we have and a 401
# is reported as "backend requires a matching token" instead of a silent failure.
#
# Everything learned is written to ostra-status.json / ostra-bootstrap.log in the working directory,
# because a Kaggle version only publishes output files when the run ends.
#
# Config (Kaggle > Add-ons > Secrets):
#   WORKER_REGISTRATION_TOKEN  (required only if Render sets it)  must match the backend value
#   OSTRA_API_URL              (optional)  defaults to DEFAULT_API_URL below
#   OSTRA_KEEPALIVE_MINUTES    (optional)  how long to hold the runtime open (default 10)
#   NGROK_AUTHTOKEN            (required)  for the public tunnel cell

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

# ── agent identity (managed by scripts/kaggle-agent-notebook.ts) ──
# A deliberate model pin is injected by the generator as OSTRA_MODEL_DEFAULT into the model server
# cell. The bootstrap must NOT define it here — that would shadow the reporting chain below and
# make registration claim a model the runtime never booted.
OSTRA_AGENT = "image"

# Per-role identity. The backend stores an agent as a worker of this `type`, so the channel can pick
# it by role. All four roles share the same Kaggle runtime/provider so registration upserts cleanly.
AGENT_PROFILES = {
    "script": {
        "worker_id": "script-ai-kaggle",
        "worker_type": "script",
        "model": "Qwen/Qwen3-4B",
        "capabilities": [
            "story_development", "script_writing", "scene_planning", "dialogue",
            "narration_text", "image_prompts", "story_continuity",
        ],
    },
    "image": {
        "worker_id": "image-ai-kaggle",
        "worker_type": "image",
        "model": "Qwen/Qwen3-4B",
        "capabilities": [
            "character_design", "visual_consistency", "scene_composition",
            "image_prompting", "style_bible",
        ],
    },
    "voice": {
        "worker_id": "voice-ai-kaggle",
        "worker_type": "voice",
        "model": "Qwen/Qwen3-4B",
        "capabilities": [
            "narration_direction", "pacing", "dialogue_timing", "audio_mix", "scene_alignment",
        ],
    },
    "overseer": {
        "worker_id": "showrunner-ai-kaggle",
        "worker_type": "overseer",
        "model": "Qwen/Qwen3-4B",
        "capabilities": ["oversight", "conflict_detection", "status_reporting", "handoff_summary"],
    },
}

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

_PROFILE = AGENT_PROFILES.get(OSTRA_AGENT)
if _PROFILE is None:
    raise ValueError(
        f"unknown OSTRA_AGENT {OSTRA_AGENT!r} — expected one of {sorted(AGENT_PROFILES)}. "
        "This notebook's identity line was not generated correctly."
    )

WORKER = {
    "worker_id": _PROFILE["worker_id"],
    "worker_type": _PROFILE["worker_type"],
    "runtime": "kaggle",
    "provider": "kaggle",
    # Report the model ACTUALLY booted: the model server cell resolves MODEL_ID before this cell
    # runs. The secret/profile are fallbacks for a standalone run — never a claim about the runtime.
    "model": (globals().get("MODEL_ID") or _secret("OSTRA_MODEL") or _PROFILE["model"]),
    "capabilities": _PROFILE["capabilities"],
    "status": "ONLINE",
}

STATUS = {
    "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "api_url": API_URL,
    "endpoint": ENDPOINT,
    "agent": OSTRA_AGENT,
    "worker_id": WORKER["worker_id"],
    "worker_type": WORKER["worker_type"],
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


def _post(path, payload, timeout=20):
    """POST to the Ostra API. Returns (status_code, body_text); raises only on transport errors."""
    response = requests.post(
        API_URL + path,
        headers={"Content-Type": "application/json", "x-worker-token": TOKEN},
        data=json.dumps(payload),
        timeout=timeout,
    )
    return response.status_code, response.text


def _tunnel_check():
    """GET our own public /health. Records the real HTTP status so "is this agent reachable?" has an answer."""
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


def _register(attempts=3):
    payload = dict(WORKER)
    payload["endpoint"] = ENDPOINT
    payload["metadata"] = {
        "agent": OSTRA_AGENT,
        "runtime_note": "kaggle notebook (agent channel)",
        "tunnel_health": STATUS["tunnel_health"],
    }
    # Render's free tier can take longer than a single short read timeout to answer a cold POST, and
    # a slow answer is not a failure. Retry the transport instead of declaring the agent OFFLINE.
    last = None
    for attempt in range(1, attempts + 1):
        try:
            return _post("/api/workers/register", payload, timeout=45)
        except Exception as exc:
            last = exc
            _log(f"[ostra] register attempt {attempt}/{attempts} failed ({exc}) — retrying")
            time.sleep(10)
    raise last

_log(f"[ostra] agent={OSTRA_AGENT} worker_id={WORKER['worker_id']} -> {API_URL}")
_log(f"[ostra] model={WORKER['model']}")
_log(f"[ostra] endpoint={ENDPOINT or '(no tunnel URL — PUBLIC_URL not set)'}")
_log(f"[ostra] registration token locally: {'set' if TOKEN else 'NOT set'}")

# 1) Prove the public tunnel (and the model server behind it) before claiming anything about the worker.
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
    _log(f"[ostra] NOT REGISTERED — {OSTRA_AGENT} stays OFFLINE.")
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
    # so the agent is genuinely ONLINE, then end cleanly so this version publishes its outputs.
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
        _log("[ostra] keep-alive window elapsed — this run is ending (agent will go OFFLINE)")

STATUS["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
_write_status()
