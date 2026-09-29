"use client";
// apps/web/src/app/runner/page.tsx
// The Runner: one button per AI model. Pressing it issues a REAL start through the orchestrator
// (`POST /api/runtime/run-now`) — for Script AI that re-pushes the Kaggle notebook as a new version,
// which makes Kaggle run the whole notebook (all cells) before any worker can register and heartbeat.
//
// Nothing on this page is simulated. The button reports the action the API actually returned, and the
// lifecycle pill comes from the persisted `runtime_startup_history` row for this model.
import { useCallback, useEffect, useMemo, useState } from "react";
import { MODEL_CATALOG } from "@ostra/shared";
import { TopNav } from "@/components/TopNav";
import { Card, CardHeader } from "@/components/ui/Card";
import { heartbeatAgeLabel, PROVIDER_LABELS, statusLabel, statusTone, type StatusTone } from "@/lib/health";
import { DISPATCH_STYLE, dispatchLabel, fetchModels, type ModelView } from "@/lib/models";
import {
  RUN_TONE_PILL,
  fetchRunHistory,
  isRemotelyStartable,
  latestByTarget,
  remoteStartKind,
  runActionTone,
  runModelNow,
  runResultSentence,
  runRowLabel,
  runRowTone,
  targetKey,
  type RunNowResult,
  type RunnerHistoryRow,
} from "@/lib/runner";

const TONE_PILL: Record<StatusTone, string> = {
  ok: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  info: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  warn: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  bad: "bg-red-500/15 text-red-300 border-red-500/30",
  muted: "bg-white/[0.06] text-zinc-300 border-white/10",
};

function Pill({ tone, children }: { tone: StatusTone; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold tracking-wide ${TONE_PILL[tone]}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
      {children}
    </span>
  );
}

function RunButton({
  label,
  busy,
  disabled,
  disabledReason,
  onClick,
}: {
  label: string;
  busy: boolean;
  disabled: boolean;
  disabledReason?: string;
  onClick: () => void;
}) {
  return (
    <div className="flex w-full flex-col items-stretch gap-1 sm:w-auto sm:items-end">
      <button
        type="button"
        onClick={onClick}
        disabled={busy || disabled}
        title={disabled ? disabledReason : undefined}
        className={`w-full rounded-full px-5 py-2.5 text-[13px] font-semibold transition sm:w-auto ${
          disabled
            ? "cursor-not-allowed border border-white/10 bg-white/[0.04] text-zinc-500"
            : "bg-[#FF4D5A] text-white shadow-[0_8px_20px_rgba(255,77,90,0.3)] hover:bg-[#ff5e6a] disabled:opacity-60"
        }`}
      >
        {busy ? "Starting…" : label}
      </button>
      {disabled && disabledReason && (
        <span className="text-[10px] leading-4 text-[#6B7594] sm:text-right">{disabledReason}</span>
      )}
    </div>
  );
}

function ModelRunnerCard({
  entry,
  view,
  latest,
  result,
  busy,
  onRun,
}: {
  entry: (typeof MODEL_CATALOG)[number];
  view: ModelView | null;
  latest: RunnerHistoryRow | null;
  result: RunNowResult | null;
  busy: boolean;
  onRun: () => void;
}) {
  const kind = remoteStartKind(entry.runtime);
  const startable = isRemotelyStartable(entry.runtime);
  const switchedOff = view ? !view.enabled : false;
  const healthTone = statusTone(view?.health?.status);
  const runTone = runRowTone(latest);

  const disabledReason = !startable
    ? `No start path for runtime "${entry.runtime}" — Run Now answers not_autostartable.`
    : switchedOff
      ? "Switched off in Models — switch it on there first."
      : undefined;

  return (
    <div
      className={`rounded-2xl border p-4 transition ${
        switchedOff ? "border-white/[0.04] bg-white/[0.02]" : "border-white/[0.08] bg-[#0F1425]"
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-semibold tracking-tight text-white">{entry.label}</span>
            {kind === "kaggle" && (
              <span className="rounded-full bg-[#FF4D5A]/15 px-2 py-0.5 text-[10px] font-bold tracking-wide text-[#FF8A93]">
                KAGGLE NOTEBOOK
              </span>
            )}
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-[#6B7594]">
            {entry.provider} · {entry.runtime} · {entry.key}
          </div>
        </div>
        <RunButton
          label={`Run ${PROVIDER_LABELS[entry.providerId] ?? entry.providerId}`}
          busy={busy}
          disabled={!startable || switchedOff}
          disabledReason={disabledReason}
          onClick={onRun}
        />
      </div>

      <p className="mt-2 text-[12px] leading-5 text-[#9AA3C0]">{entry.description}</p>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {view ? (
          <>
            <span
              className={`rounded-full border px-2.5 py-1 text-[10px] font-bold tracking-wide ${
                view.enabled ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-white/10 bg-white/[0.04] text-zinc-400"
              }`}
            >
              SWITCH {view.enabled ? "ON" : "OFF"}
            </span>
            <Pill tone={healthTone}>HEALTH {statusLabel(view.health?.status)}</Pill>
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold tracking-wide ${DISPATCH_STYLE[view.dispatch].pill}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${DISPATCH_STYLE[view.dispatch].dot}`} />
              {dispatchLabel(view.dispatch)}
            </span>
          </>
        ) : (
          <Pill tone="muted">SWITCH / HEALTH UNKNOWN</Pill>
        )}
        <Pill tone={runTone}>RUN {runRowLabel(latest)}</Pill>
      </div>

      {result && (
        <div
          className={`mt-3 rounded-xl border px-3 py-2 text-[12px] leading-5 ${
            result.reachable ? RUN_TONE_PILL[runActionTone(result.action)] : "border-red-500/25 bg-red-500/10 text-red-200"
          }`}
        >
          {result.reachable ? runResultSentence(result) : `No answer from the orchestrator — ${result.error}`}
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-[#6B7594]">
        {view?.health?.lastHeartbeatAt !== undefined && <span>heartbeat {heartbeatAgeLabel(view?.health?.lastHeartbeatAt)}</span>}
        {latest ? (
          <>
            <span>last run {new Date(latest.requested_at).toLocaleString()}</span>
            <span>via {latest.trigger_source}</span>
            {latest.provider_run_id && <span>run {latest.provider_run_id}</span>}
          </>
        ) : (
          <span>no start recorded for this model yet</span>
        )}
      </div>
      {latest && (latest.error || latest.error_code) && (
        <div className="mt-1 text-[11px] leading-4 text-[#9AA3C0]">
          {latest.error_code ? `[${latest.error_code}] ` : ""}
          {latest.error}
        </div>
      )}
    </div>
  );
}

export default function RunnerPage() {
  const [models, setModels] = useState<ModelView[] | null>(null);
  const [modelsErr, setModelsErr] = useState<string | null>(null);
  const [history, setHistory] = useState<RunnerHistoryRow[]>([]);
  const [historyErr, setHistoryErr] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, RunNowResult>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [m, h] = await Promise.all([fetchModels(), fetchRunHistory(40)]);
    if (m.reachable) {
      setModels(m.models);
      setModelsErr(m.error ?? null);
    } else {
      setModels(null);
      setModelsErr(m.error ?? "unreachable");
    }
    if (h.reachable) {
      setHistory(h.rows);
      setHistoryErr(null);
    } else {
      setHistoryErr(h.error ?? "unreachable");
    }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 12_000);
    return () => clearInterval(iv);
  }, [load]);

  const latest = useMemo(() => latestByTarget(history), [history]);
  const viewByKey = useMemo(() => {
    const m: Record<string, ModelView> = {};
    for (const v of models ?? []) m[v.key] = v;
    return m;
  }, [models]);

  async function run(entry: (typeof MODEL_CATALOG)[number]) {
    setBusy(entry.key);
    const r = await runModelNow({ worker_type: entry.providerId, runtime: entry.runtime, provider: entry.provider });
    setResults((prev) => ({ ...prev, [entry.key]: r }));
    await load();
    setBusy(null);
  }

  const onlineCount = (models ?? []).filter((m) => m.health?.status === "ONLINE").length;

  return (
    <div className="min-h-screen bg-[#070A14]">
      <TopNav />
      <main className="mx-auto max-w-[1100px] space-y-4 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="label-mono text-[#6B7594]">MANUAL CONTROL — ONE BUTTON PER AI</div>
            <h1 className="text-[22px] font-bold tracking-tight text-white">Runner</h1>
            <p className="max-w-[70ch] text-[13px] leading-6 text-[#9AA3C0]">
              Each button asks the orchestrator to start that AI&apos;s real runtime. For{" "}
              <span className="text-white">Script AI on Kaggle</span> this re-pushes the notebook configured as{" "}
              <span className="font-mono text-white">KAGGLE_KERNEL_REF</span> as a new version, so Kaggle runs the
              entire notebook — all cells — and the worker only becomes{" "}
              <span className="text-white">ONLINE</span> once it tunnels in, registers and heartbeats. A requested
              start is never shown as online, and a refusal is shown as the refusal it was.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-[11px] text-zinc-300">
              {onlineCount} online now
            </span>
            <button
              onClick={load}
              className="rounded-full bg-white px-4 py-2 text-[13px] font-semibold text-[#070A14] hover:bg-zinc-100"
            >
              Refresh
            </button>
          </div>
        </div>

        {modelsErr && (
          <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-200">
            <span className="font-semibold">SWITCH + HEALTH UNAVAILABLE</span> — {modelsErr}. The run buttons still work:
            the orchestrator enforces the same switches and health rules. Missing endpoint usually means the Render API
            has not been redeployed since <span className="font-mono">/api/models</span> was added.
          </div>
        )}
        {historyErr && (
          <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-[13px] text-red-200">
            <span className="font-semibold">STARTUP HISTORY UNAVAILABLE</span> — {historyErr}. Buttons will still report
            the orchestrator&apos;s answer, but the run log cannot be shown.
          </div>
        )}

        <Card>
          <CardHeader
            kicker="START A RUNTIME"
            title="Press a button to run that AI"
            action={<span className="label-mono hidden text-[#6B7594] sm:inline">POST /api/runtime/run-now</span>}
          />
          <div className="grid gap-3 lg:grid-cols-2">
            {MODEL_CATALOG.map((entry) => (
              <ModelRunnerCard
                key={entry.key}
                entry={entry}
                view={viewByKey[entry.key] ?? null}
                latest={latest[targetKey(entry.providerId, entry.runtime)] ?? null}
                result={results[entry.key] ?? null}
                busy={busy === entry.key}
                onRun={() => run(entry)}
              />
            ))}
          </div>
          <div className="mt-3 text-[11px] leading-4 text-[#6B7594]">
            One lease per model, so a double press cannot start two notebooks. If a worker is already healthy the
            orchestrator answers <span className="font-mono text-white">skipped_already_online</span> instead of starting a
            duplicate.
          </div>
        </Card>

        <Card>
          <CardHeader
            kicker="RUN LOG — runtime_startup_history"
            title={history.length ? `${history.length} most recent start attempts` : "No start attempts yet"}
            action={
              <button
                onClick={load}
                className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] text-white"
              >
                Refresh
              </button>
            }
          />
          {history.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-8 text-center text-sm text-[#6B7594]">
              Nothing recorded yet. Press a run button and the attempt appears here — including the ones that were
              skipped and why.
            </div>
          ) : (
            <div className="space-y-2">
              {history.map((h) => (
                <div key={h.id} className="rounded-xl border border-white/[0.06] bg-[#0F1425] px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[12px] font-semibold text-white">
                      {h.worker_type}/{h.runtime}
                    </span>
                    <Pill tone={runRowTone(h)}>{runRowLabel(h)}</Pill>
                    <span className="font-mono text-[11px] text-zinc-500">{h.trigger_source}</span>
                    <span className="font-mono text-[11px] text-zinc-500">{new Date(h.requested_at).toLocaleString()}</span>
                  </div>
                  {(h.error || h.error_code) && (
                    <div className="mt-1 text-[12px] text-[#9AA3C0]">
                      {h.error_code ? `[${h.error_code}] ` : ""}
                      {h.error}
                    </div>
                  )}
                  <div className="mt-1 font-mono text-[10px] text-[#6B7594]">
                    {h.id.slice(0, 8)}
                    {h.provider_run_id ? ` · provider ${h.provider_run_id}` : ""}
                    {h.startup_request_id ? ` · req ${h.startup_request_id.slice(0, 16)}` : ""}
                    {h.started_at ? ` · started ${new Date(h.started_at).toLocaleTimeString()}` : ""}
                    {h.registered_at ? ` · registered ${new Date(h.registered_at).toLocaleTimeString()}` : ""}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader kicker="WHAT ACTUALLY HAPPENS" title="Honest expectations for a run" />
          <div className="grid gap-3 text-[12px] leading-5 text-[#9AA3C0] sm:grid-cols-2">
            <div className="rounded-xl border border-white/[0.06] bg-[#0F1425] p-3">
              <div className="label-mono mb-1 text-[#6B7594]">KAGGLE · SCRIPT AI</div>
              The push creates a new version of the notebook, so Kaggle re-runs it from the top and executes{" "}
              <span className="text-white">every cell</span>. Kaggle aborts the whole version at the first uncaught
              exception, so a failed cell means no output files and no worker — you get a{" "}
              <span className="font-mono text-white">failed</span> row, not a green one.
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-[#0F1425] p-3">
              <div className="label-mono mb-1 text-[#6B7594]">LIFECYCLE</div>
              <span className="font-mono text-white">REQUESTED → STARTING → REGISTERING → ONLINE</span>, or{" "}
              <span className="font-mono text-white">FAILED / TIMEOUT / CANCELLED</span>. Only a real{" "}
              <span className="font-mono text-white">POST /api/workers/register</span> plus heartbeats makes a worker
              ONLINE.
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-[#0F1425] p-3">
              <div className="label-mono mb-1 text-[#6B7594]">IT GOES OFFLINE AGAIN</div>
              A Kaggle run is not permanent. The notebook keeps its tunnel alive for its keep-alive window, then stops
              heartbeating; after the heartbeat timeout Render marks the worker OFFLINE, truthfully. Press run again to
              start a fresh version.
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-[#0F1425] p-3">
              <div className="label-mono mb-1 text-[#6B7594]">COL · LOCAL · API RUNTIMES</div>
              Colab Image/Voice report <span className="font-mono text-white">NOT_AUTOSTARTABLE</span> until their
              credentials are configured on Render. Video (<span className="font-mono">local</span>) and YouTube (
              <span className="font-mono">api</span>) have no remote starter at all, so their buttons are disabled here
              rather than pretending to do something.
            </div>
          </div>
          <div className="mt-3 text-[11px] leading-4 text-[#6B7594]">
            No mock mode, no fake results, no fake success. Every state on this page comes from the orchestrator&apos;s own
            answer and the persisted startup history.
          </div>
        </Card>
      </main>
    </div>
  );
}
