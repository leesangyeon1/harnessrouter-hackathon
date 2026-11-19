"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Cpu,
  Database,
  ExternalLink,
  FileText,
  LoaderCircle,
  MessageSquarePlus,
  RefreshCw,
  X,
} from "lucide-react";
import type {
  AgentTask,
  FinanceApi,
  QuantEvaluationBundle,
  QuantEvaluationItem,
} from "@/lib/api";
import "./quant-emulator.css";

const QUICK_SYMBOLS = ["AAPL", "TLT", "BTC/USD", "NVDA", "IEF"];

function isTerminal(status: AgentTask["status"]): boolean {
  return (
    status === "completed" ||
    status === "incomplete" ||
    status === "failed" ||
    status === "cancelled"
  );
}

type NormalizedCandidateRow = {
  modelId: string;
  selReturn: string;
  selSharpe: string;
  selDrawdown: string;
  confReturn: string;
  confSharpe: string;
  confDrawdown: string;
};

function fmtPct(val: unknown): string {
  if (typeof val !== "number" || !Number.isFinite(val)) return "—";
  return `${(val * 100).toFixed(2)}%`;
}

function fmtNum(val: unknown): string {
  if (typeof val !== "number" || !Number.isFinite(val)) return "—";
  return val.toFixed(3);
}

function extractMetricsPair(entry: Record<string, unknown>): {
  sel: Record<string, unknown>;
  conf: Record<string, unknown>;
} {
  const sel =
    entry.selection && typeof entry.selection === "object"
      ? (entry.selection as Record<string, unknown>)
      : {
          net_return: entry.selection_net_return ?? entry.selection_return,
          sharpe: entry.selection_sharpe,
          max_drawdown: entry.selection_max_drawdown ?? entry.max_drawdown,
        };
  const conf =
    entry.confirmation && typeof entry.confirmation === "object"
      ? (entry.confirmation as Record<string, unknown>)
      : {
          net_return:
            entry.confirmation_net_return ?? entry.confirmation_return,
          sharpe: entry.confirmation_sharpe,
          max_drawdown: entry.confirmation_max_drawdown,
        };
  return { sel, conf };
}

function normalizeCandidateMetrics(
  raw: QuantEvaluationItem["candidate_metrics"],
): NormalizedCandidateRow[] {
  if (!raw) return [];
  const rows: NormalizedCandidateRow[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const modelId = String(obj.model_id ?? obj.id ?? "—");
      const { sel, conf } = extractMetricsPair(obj);
      rows.push({
        modelId,
        selReturn: fmtPct(sel.net_return),
        selSharpe: fmtNum(sel.sharpe),
        selDrawdown: fmtPct(sel.max_drawdown),
        confReturn: fmtPct(conf.net_return),
        confSharpe: fmtNum(conf.sharpe),
        confDrawdown: fmtPct(conf.max_drawdown),
      });
    }
  } else if (typeof raw === "object") {
    for (const [key, val] of Object.entries(raw)) {
      if (!val || typeof val !== "object") continue;
      const { sel, conf } = extractMetricsPair(val as Record<string, unknown>);
      rows.push({
        modelId: key,
        selReturn: fmtPct(sel.net_return),
        selSharpe: fmtNum(sel.sharpe),
        selDrawdown: fmtPct(sel.max_drawdown),
        confReturn: fmtPct(conf.net_return),
        confSharpe: fmtNum(conf.sharpe),
        confDrawdown: fmtPct(conf.max_drawdown),
      });
    }
  }
  return rows;
}

function formatReasons(reasons: QuantEvaluationItem["reasons"]): string[] {
  if (!reasons) return [];
  if (typeof reasons === "string") return [reasons];
  if (Array.isArray(reasons)) {
    return reasons.map((r) =>
      typeof r === "string" ? r : JSON.stringify(r),
    );
  }
  if (typeof reasons === "object") {
    return Object.entries(reasons).map(
      ([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
    );
  }
  return [];
}

export function QuantEmulator({
  api,
  demo,
  onRequireSignIn,
}: {
  api: FinanceApi | null;
  demo: boolean;
  onRequireSignIn: () => void;
}) {
  const promptFieldId = useId();
  const symbolFieldId = useId();
  const followUpFieldId = useId();

  const [symbolInput, setSymbolInput] = useState("AAPL");
  const [bundleMeta, setBundleMeta] = useState<
    QuantEvaluationBundle["pinned_identities"] | null
  >(null);
  const [cycleSymbols, setCycleSymbols] = useState<string[]>([]);
  const [loadingBundle, setLoadingBundle] = useState(false);

  const [promptInput, setPromptInput] = useState("");
  const [followUpInput, setFollowUpInput] = useState("");
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [activeTask, setActiveTask] = useState<AgentTask | null>(null);
  const [activityLabel, setActivityLabel] = useState(
    "Starting isolated CPU quant evaluation…",
  );
  const [streamDelta, setStreamDelta] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);

  const upsertTaskList = useCallback((updated: AgentTask) => {
    setTasks((prev) => {
      const filtered = prev.filter((item) => item.id !== updated.id);
      return [updated, ...filtered].slice(0, 20);
    });
  }, []);

  const watchTask = useCallback(
    async (client: FinanceApi, task: AgentTask) => {
      streamAbortRef.current?.abort();
      const abort = new AbortController();
      streamAbortRef.current = abort;
      setActivityLabel("Connecting to CPU quant evaluator…");
      setStreamDelta("");

      try {
        await client.streamAgentTaskEvents(
          task.id,
          (ev) => {
            if (ev.kind === "activity") {
              setActivityLabel(ev.label);
            } else if (ev.kind === "text") {
              setStreamDelta((prev) => (prev + ev.delta).slice(-1400));
            }
          },
          abort.signal,
        );
      } catch {
        /* Fallback polling below resolves terminal state */
      }

      while (!abort.signal.aborted) {
        try {
          const refreshed = await client.getAgentTask(task.id);
          setActiveTask(refreshed);
          upsertTaskList(refreshed);
          if (isTerminal(refreshed.status)) {
            if (
              refreshed.status === "failed" ||
              refreshed.status === "cancelled"
            ) {
              setStreamDelta("");
            }
            break;
          }
        } catch (caught) {
          if (!abort.signal.aborted) {
            setError(
              caught instanceof Error
                ? caught.message
                : "Quant evaluation status could not be refreshed.",
            );
          }
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    },
    [upsertTaskList],
  );

  const loadPinnedBundle = useCallback(
    async (targetSymbol: string) => {
      if (demo || !api) {
        onRequireSignIn();
        return;
      }
      setLoadingBundle(true);
      setError(null);
      try {
        const bundle = await api.getQuantBundle(targetSymbol, "auto");
        setSymbolInput(bundle.pinned_identities.symbol);
        setBundleMeta(bundle.pinned_identities);
        setCycleSymbols(bundle.available_cycle_symbols);
        setPromptInput(bundle.prompt);
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : "Could not assemble pinned finance_core bundle.",
        );
      } finally {
        setLoadingBundle(false);
      }
    },
    [api, demo, onRequireSignIn],
  );

  useEffect(() => {
    if (!api || demo) return;
    let cancelled = false;
    void Promise.all([
      api.listAgentTasks("quant_eval"),
      api.getQuantBundle("AAPL", "auto").catch(() => null),
    ]).then(([loadedTasks, initialBundle]) => {
      if (cancelled) return;
      setTasks(loadedTasks);
      if (loadedTasks.length > 0) {
        setActiveTask(loadedTasks[0]);
        if (!isTerminal(loadedTasks[0].status)) {
          void watchTask(api, loadedTasks[0]);
        }
      }
      if (initialBundle) {
        setBundleMeta(initialBundle.pinned_identities);
        setCycleSymbols(initialBundle.available_cycle_symbols);
        setPromptInput((prev) => prev || initialBundle.prompt);
      }
    });
    return () => {
      cancelled = true;
      streamAbortRef.current?.abort();
    };
  }, [api, demo, watchTask]);

  async function submitEvaluation(event: FormEvent) {
    event.preventDefault();
    if (demo || !api) {
      onRequireSignIn();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      let textToSend = promptInput.trim();
      if (!textToSend) {
        const autoBundle = await api.getQuantBundle(
          symbolInput.trim() || "AAPL",
          "auto",
        );
        setBundleMeta(autoBundle.pinned_identities);
        setPromptInput(autoBundle.prompt);
        textToSend = autoBundle.prompt;
      }
      const created = await api.startAgentTask(textToSend, {
        featureKey: "quant_eval",
      });
      setActiveTask(created);
      upsertTaskList(created);
      void watchTask(api, created);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The quant evaluation could not be started.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function submitFollowUp(event: FormEvent) {
    event.preventDefault();
    if (demo || !api || !activeTask) return;
    const trimmed = followUpInput.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await api.startAgentTask(trimmed, {
        featureKey: "quant_eval",
        followUpTaskId: activeTask.id,
      });
      setFollowUpInput("");
      setActiveTask(created);
      upsertTaskList(created);
      void watchTask(api, created);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Follow-up could not be sent.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelActive() {
    if (!api || !activeTask) return;
    streamAbortRef.current?.abort();
    try {
      const cancelledTask = await api.cancelAgentTask(activeTask.id);
      setActiveTask(cancelledTask);
      upsertTaskList(cancelledTask);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The evaluation could not be cancelled.",
      );
    }
  }

  const running = Boolean(activeTask && !isTerminal(activeTask.status));
  const quantResult = activeTask?.quant_result ?? null;

  return (
    <div className="quant-emulator">
      <section className="panel quant-compose">
        <div>
          <span className="eyebrow">
            ISOLATED CPU CLOUD QUANT EMULATOR · DAILY-V1 MODELS
          </span>
          <h2>
            Evaluate M01–M08, M10 &amp; M11 against M00 baseline with pinned
            identities
          </h2>
          <p className="small muted">
            Executes verbatim <code>finance_core/quant.py</code> in an isolated
            CPU sandbox on HarnessRouter Cloud, verifying SHA-256{" "}
            <code>bars_hash</code>, <code>policy_hash</code>, and{" "}
            <code>costs_hash</code> before ranking Stable (Sharpe within 20%
            drawdown) and Aggressive (net return) winners with 60-bar positive
            confirmation.
          </p>
        </div>

        <div className="quant-bundle-bar">
          <div className="quant-symbol-controls">
            <label htmlFor={symbolFieldId} className="small strong">
              Symbol
            </label>
            <input
              id={symbolFieldId}
              className="quant-symbol-input"
              type="text"
              value={symbolInput}
              onChange={(e) => setSymbolInput(e.target.value.toUpperCase())}
              placeholder="AAPL"
            />
            <button
              type="button"
              className="button secondary"
              disabled={loadingBundle}
              onClick={() => void loadPinnedBundle(symbolInput || "AAPL")}
            >
              {loadingBundle ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Database size={15} />
              )}
              Load pinned bundle
            </button>
          </div>
          <div className="quant-symbol-controls">
            {(cycleSymbols.length > 0 ? cycleSymbols.slice(0, 5) : QUICK_SYMBOLS).map(
              (sym) => (
                <button
                  key={sym}
                  type="button"
                  className={`quant-chip ${
                    bundleMeta?.symbol === sym ? "active" : ""
                  }`}
                  onClick={() => {
                    setSymbolInput(sym);
                    void loadPinnedBundle(sym);
                  }}
                >
                  {sym}
                </button>
              ),
            )}
          </div>
        </div>

        {bundleMeta && (
          <dl className="quant-hash-strip">
            <div>
              <dt>Cycle &amp; origin</dt>
              <dd>
                {bundleMeta.symbol} ({bundleMeta.sector}) ·{" "}
                {bundleMeta.data_origin === "stored_cycle"
                  ? "Live stored cycle"
                  : "Pinned 260d series"}
              </dd>
            </div>
            <div>
              <dt>Model set &amp; policy</dt>
              <dd>
                {bundleMeta.model_set_version} · v{bundleMeta.policy_version} (
                {bundleMeta.bars_count} bars)
              </dd>
            </div>
            <div>
              <dt>Pinned bars_hash</dt>
              <dd>{bundleMeta.bars_hash.slice(0, 18)}…</dd>
            </div>
            <div>
              <dt>Policy / costs hash</dt>
              <dd>
                {bundleMeta.policy_hash.slice(0, 10)}… /{" "}
                {bundleMeta.costs_hash.slice(0, 10)}…
              </dd>
            </div>
          </dl>
        )}

        <form className="advisor-form" onSubmit={(e) => void submitEvaluation(e)}>
          <label htmlFor={promptFieldId} className="sr-only">
            finance_core Python code and pinned cycle evaluation payload
          </label>
          <textarea
            id={promptFieldId}
            className="quant-textarea"
            placeholder={
              demo
                ? "Sign in and click 'Load pinned bundle' to assemble verbatim finance_core/quant.py + 260+ pinned daily OHLCV bars and SHA-256 hashes, or paste an authenticated worker result payload…"
                : "Pinned finance_core/quant.py + OHLCV payload ready to execute…"
            }
            value={promptInput}
            onChange={(e) => setPromptInput(e.target.value)}
            disabled={submitting}
          />
          <div className="quant-submit-row">
            <span className="small muted">
              All outputs carry <code>simulation_label: SIMULATED</code>. M00 is
              retained strictly as baseline context and excluded from winner
              pools.
            </span>
            <button
              type="submit"
              className="button primary"
              disabled={submitting}
            >
              {submitting ? (
                <>
                  <LoaderCircle size={16} className="spin" />
                  Dispatching…
                </>
              ) : demo ? (
                <>
                  Sign in to run emulator
                  <ArrowRight size={15} />
                </>
              ) : (
                <>
                  <Cpu size={16} />
                  Run CPU quant emulator
                </>
              )}
            </button>
          </div>
        </form>
      </section>

      {error && (
        <div className="error-banner" role="alert">
          <CircleAlert size={16} />
          <span>{error}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Dismiss quant emulator error"
            onClick={() => setError(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}

      {running && activeTask && (
        <section className="panel advisor-progress-panel" role="status">
          <div className="advisor-progress-top">
            <span className="advisor-progress-status">
              <LoaderCircle size={18} className="spin" />
              {activityLabel}
            </span>
            <button
              type="button"
              className="button secondary"
              onClick={() => void cancelActive()}
            >
              Cancel
            </button>
          </div>
          <p className="small muted">
            Executing isolated CPU backtest:{" "}
            <strong>{activeTask.query}</strong>
          </p>
          {streamDelta && (
            <pre className="quant-stream-preview">{streamDelta}</pre>
          )}
        </section>
      )}

      {activeTask && isTerminal(activeTask.status) && (
        <section className="panel">
          <div className="card-heading">
            <div>
              <span className="eyebrow">
                {quantResult?.simulation_label ?? "SIMULATED"} · STRATEGY
                EVALUATION
              </span>
              <h2>{activeTask.query}</h2>
            </div>
            <span
              className={`pill ${
                activeTask.status === "completed" &&
                quantResult?.status === "ok"
                  ? "positive-pill"
                  : "neutral-pill"
              }`}
            >
              {activeTask.status === "completed" && <CheckCircle2 size={12} />}
              {quantResult?.status
                ? `Status: ${quantResult.status}`
                : activeTask.status}
            </span>
          </div>

          {activeTask.status === "failed" && (
            <p className="coral-text small">
              This CPU strategy evaluation could not be completed. Please try
              again with a new request.
            </p>
          )}

          {activeTask.status === "cancelled" && (
            <p className="muted small">This evaluation was cancelled.</p>
          )}

          {activeTask.status === "incomplete" && (
            <div className="advisor-callout" style={{ marginBottom: 12 }}>
              Evaluation paused early (
              {activeTask.incomplete_reason ?? "budget limit"}). Send a
              follow-up to continue.
            </div>
          )}

          {quantResult ? (
            <>
              {quantResult.evaluations.map((evItem, idx) => {
                const candidates = normalizeCandidateMetrics(
                  evItem.candidate_metrics,
                );
                const reasonLines = formatReasons(evItem.reasons);
                const baselinePair =
                  evItem.baseline && typeof evItem.baseline === "object"
                    ? extractMetricsPair(evItem.baseline)
                    : null;

                return (
                  <div
                    className="quant-eval-card"
                    key={`${evItem.cycle_id ?? "c"}-${evItem.symbol ?? idx}`}
                  >
                    <div className="quant-winners-grid">
                      <div className="quant-winner-box">
                        <span className="eyebrow">STABLE MODE WINNER</span>
                        <div className="quant-winner-id">
                          {evItem.stable_winner ?? "None (null)"}
                        </div>
                        <span className="small muted">
                          Highest selection Sharpe ≤ 20% drawdown &amp; &gt;0%
                          confirmation
                        </span>
                      </div>
                      <div className="quant-winner-box">
                        <span className="eyebrow">AGGRESSIVE MODE WINNER</span>
                        <div className="quant-winner-id">
                          {evItem.aggressive_winner ?? "None (null)"}
                        </div>
                        <span className="small muted">
                          Highest selection net return &amp; &gt;0% confirmation
                        </span>
                      </div>
                      <div className="quant-winner-box">
                        <span className="eyebrow">
                          M00 BASELINE ({evItem.symbol ?? "ASSET"})
                        </span>
                        <div className="quant-winner-id">
                          {baselinePair
                            ? fmtPct(baselinePair.sel.net_return)
                            : "—"}
                        </div>
                        <span className="small muted">
                          Selection Sharpe{" "}
                          {baselinePair ? fmtNum(baselinePair.sel.sharpe) : "—"}{" "}
                          · Conf{" "}
                          {baselinePair
                            ? fmtPct(baselinePair.conf.net_return)
                            : "—"}
                        </span>
                      </div>
                    </div>

                    {candidates.length > 0 && (
                      <div
                        className="table-scroll"
                        tabIndex={0}
                        role="region"
                        aria-label={`Simulated candidate metrics for ${evItem.symbol ?? "symbol"}`}
                      >
                        <table>
                          <thead>
                            <tr>
                              <th>Model</th>
                              <th>Sel. Return</th>
                              <th>Sel. Sharpe</th>
                              <th>Sel. Max DD</th>
                              <th>Conf. Return</th>
                              <th>Conf. Sharpe</th>
                              <th>Winner</th>
                            </tr>
                          </thead>
                          <tbody>
                            {candidates.map((row) => {
                              const wonStable =
                                evItem.stable_winner === row.modelId;
                              const wonAggr =
                                evItem.aggressive_winner === row.modelId;
                              return (
                                <tr key={row.modelId}>
                                  <td>
                                    <span className="model-tag">
                                      {row.modelId}
                                    </span>
                                  </td>
                                  <td className="strong">{row.selReturn}</td>
                                  <td>{row.selSharpe}</td>
                                  <td>{row.selDrawdown}</td>
                                  <td
                                    className={
                                      row.confReturn.startsWith("-")
                                        ? "coral-text"
                                        : "positive"
                                    }
                                  >
                                    {row.confReturn}
                                  </td>
                                  <td>{row.confSharpe}</td>
                                  <td>
                                    {wonStable || wonAggr ? (
                                      <span className="pill positive-pill">
                                        {[
                                          wonStable ? "Stable" : null,
                                          wonAggr ? "Aggressive" : null,
                                        ]
                                          .filter(Boolean)
                                          .join(" + ")}
                                      </span>
                                    ) : (
                                      <span className="muted small">—</span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {reasonLines.length > 0 && (
                      <div>
                        <strong className="small">Decision rationale</strong>
                        <ul className="verifier-facts">
                          {reasonLines.map((line, rIdx) => (
                            <li key={rIdx} className="small muted">
                              {line}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                );
              })}

              {Array.isArray(quantResult.issues) &&
                quantResult.issues.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <strong className="small">Validation &amp; issues</strong>
                    <ul className="verifier-facts">
                      {quantResult.issues.map((iss, idx) => (
                        <li key={idx} className="small muted">
                          {typeof iss === "string"
                            ? iss
                            : JSON.stringify(iss)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
            </>
          ) : (
            activeTask.answer &&
            activeTask.status !== "failed" &&
            activeTask.status !== "cancelled" && (
              <pre
                className="quant-stream-preview"
                style={{ maxHeight: 340, marginTop: 12 }}
              >
                {activeTask.answer}
              </pre>
            )
          )}

          {activeTask.files.length > 0 && api && (
            <div className="advisor-files">
              <h3>Generated files</h3>
              {activeTask.files.map((file) => (
                <div className="advisor-file-row" key={file.path}>
                  <span>
                    <FileText size={15} /> <strong>{file.filename}</strong>{" "}
                    <span className="small muted">
                      ({file.path}
                      {file.bytes !== null ? ` · ${file.bytes} bytes` : ""})
                    </span>
                  </span>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() =>
                      void api
                        .downloadAgentTaskFile(
                          file.download_path,
                          file.filename,
                        )
                        .catch((err: unknown) =>
                          setError(
                            err instanceof Error
                              ? err.message
                              : "Download failed.",
                          ),
                        )
                    }
                  >
                    <ArrowDownToLine size={14} />
                    Download
                  </button>
                </div>
              ))}
            </div>
          )}

          {activeTask.preview_url && api && (
            <div className="advisor-files">
              <div className="card-heading">
                <h3>Artifact preview</h3>
                <a
                  href={api.previewFullUrl(activeTask.preview_url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-button"
                >
                  Open in new tab
                  <ExternalLink size={14} />
                </a>
              </div>
              <iframe
                className="advisor-iframe"
                src={api.previewFullUrl(activeTask.preview_url)}
                sandbox="allow-scripts allow-forms"
                referrerPolicy="no-referrer"
                title="Sandboxed quant evaluation preview"
              />
            </div>
          )}

          {activeTask.can_continue && !demo && (
            <form
              className="quant-followup-form"
              onSubmit={(e) => void submitFollowUp(e)}
            >
              <label htmlFor={followUpFieldId} className="sr-only">
                Follow up on this quant strategy evaluation
              </label>
              <input
                id={followUpFieldId}
                type="text"
                placeholder="Ask a follow-up about candidate rankings, drawdown bounds, or confirmation returns…"
                value={followUpInput}
                onChange={(e) => setFollowUpInput(e.target.value)}
                disabled={submitting || running}
              />
              <button
                type="submit"
                className="button secondary"
                disabled={submitting || running || !followUpInput.trim()}
              >
                <MessageSquarePlus size={15} />
                Continue evaluation
              </button>
            </form>
          )}
        </section>
      )}

      {!demo && tasks.length > 0 && (
        <section className="panel">
          <div className="card-heading">
            <h2>Your CPU quant evaluation history</h2>
            {api && (
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  void api
                    .listAgentTasks("quant_eval")
                    .then((list) => setTasks(list))
                }
              >
                <RefreshCw size={14} />
                Refresh
              </button>
            )}
          </div>
          <div className="quant-history-list">
            {tasks.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`quant-history-item ${
                  activeTask?.id === item.id ? "selected" : ""
                }`}
                onClick={() => {
                  setActiveTask(item);
                  if (api && !isTerminal(item.status)) {
                    void watchTask(api, item);
                  }
                }}
              >
                <span className="advisor-history-query">
                  <strong>{item.query}</strong>
                  <span className="small muted" style={{ display: "block" }}>
                    {new Date(item.created_at).toLocaleString()}
                    {item.parent_task_id ? " · Follow-up" : ""}
                  </span>
                </span>
                <span className="pill neutral-pill">
                  {item.quant_result?.status ?? item.status}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
