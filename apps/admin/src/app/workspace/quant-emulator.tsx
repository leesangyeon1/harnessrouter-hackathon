"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Database,
  FlaskConical,
  LoaderCircle,
  Play,
  RefreshCw,
  TrendingUp,
} from "lucide-react";
import {
  candidates,
  evaluations,
  reported,
  row,
  type JsonRow,
} from "@/lib/quant-result";
import "./quant-emulator.css";

type Task = {
  id: string;
  feature_key: string;
  status: string;
  query: string;
  answer: string;
  quant_result?: unknown;
  incomplete_reason?: string | null;
  created_at: string;
  updated_at: string;
};
type Bundle = { prompt: string; pinned_identities: JsonRow };
const terminal = (status: string) =>
  ["completed", "incomplete", "failed", "cancelled"].includes(status);
const identities = [
  "cycle_id",
  "symbol",
  "sector",
  "data_origin",
  "model_set_version",
  "policy_version",
  "policy_hash",
  "costs_hash",
  "bars_count",
  "bars_hash",
  "cost_per_side",
  "confirmation_bars",
];

const QUANT_PROGRESS_STAGES = [
  {
    title: "Retrieving Market Data",
    detail: "Loading historical price series and trading calendar",
    headline: "Retrieving historical market data and benchmark pricing…",
  },
  {
    title: "Processing Data",
    detail: "Normalizing daily returns and sector transaction costs",
    headline: "Processing asset return series and trading cost schedules…",
  },
  {
    title: "Evaluating Strategies",
    detail: "Simulating trend, momentum, and mean-reversion models",
    headline: "Evaluating quantitative strategies against benchmark…",
  },
  {
    title: "Analyzing Risk",
    detail: "Measuring Sharpe ratios, volatility, and drawdown limits",
    headline: "Analyzing risk-adjusted returns and drawdown thresholds…",
  },
  {
    title: "Preparing Report",
    detail: "Confirming out-of-sample returns and portfolio rankings",
    headline: "Finalizing Stable and Aggressive portfolio rankings…",
  },
];

function formatCleanQuantScope(rawQuery: string): string {
  const symMatch = /symbol=([A-Z0-9/.-]+)\s*(?:\(([a-z_]+)\))?/i.exec(rawQuery);
  if (symMatch) {
    return `${symMatch[1].toUpperCase()} (${symMatch[2] ?? "Multi-Asset"}) · Multi-Strategy Risk & Return Evaluation`;
  }
  if (/finance_core|\.py|```|synthetic/i.test(rawQuery)) {
    return "Multi-Strategy Quantitative Portfolio Evaluation";
  }
  return rawQuery;
}

function AdminQuantProgressCard() {
  const [ticks, setTicks] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => {
      setTicks((prev) => prev + 1);
    }, 250);
    return () => window.clearInterval(timer);
  }, []);
  const elapsedSec = ticks * 0.25;
  const pct = Math.min(
    95,
    Math.max(8, Math.round(92 * (1 - Math.exp(-elapsedSec / 15)))),
  );
  const activeStage =
    pct >= 80 ? 4 : pct >= 60 ? 3 : pct >= 40 ? 2 : pct >= 20 ? 1 : 0;

  return (
    <div className="qe-progress-card" role="status" aria-live="polite">
      <div className="qe-progress-head">
        <div className="qe-progress-title">
          <span className="qe-progress-orb" aria-hidden="true">
            <TrendingUp size={17} />
          </span>
          <div>
            <span className="qe-progress-eyebrow">
              QUANTITATIVE PORTFOLIO ENGINE · LIVE EVALUATION
            </span>
            <strong>{QUANT_PROGRESS_STAGES[activeStage].headline}</strong>
          </div>
        </div>
        <div className="qe-progress-meta">
          <span>
            Step {activeStage + 1} of {QUANT_PROGRESS_STAGES.length} ·{" "}
            {elapsedSec.toFixed(1)}s
          </span>
          <strong>{pct}%</strong>
        </div>
      </div>
      <div
        className="qe-progress-track"
        role="progressbar"
        aria-label="Quantitative strategy evaluation progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className="qe-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="qe-progress-stages">
        {QUANT_PROGRESS_STAGES.map((stage, idx) => {
          const isDone = idx < activeStage;
          const isCurrent = idx === activeStage;
          return (
            <div
              key={stage.title}
              className={`qe-stage-item ${
                isDone ? "done" : isCurrent ? "active" : ""
              }`}
            >
              <div className="qe-stage-label">
                {isDone ? (
                  <CheckCircle2 size={14} />
                ) : isCurrent ? (
                  <LoaderCircle size={14} className="spin" />
                ) : (
                  <span className="qe-stage-num">{idx + 1}</span>
                )}
                <span>{stage.title}</span>
              </div>
              <small>{stage.detail}</small>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Identity({ value }: { value: unknown }) {
  const data = row(value);
  return (
    <dl className="qe-identities">
      {identities.map((key) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{reported(data[key])}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AdminQuantEmulator({
  request,
}: {
  request: (path: string, init?: RequestInit) => Promise<Response>;
}) {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [active, setActive] = useState<Task | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const submitting = useRef(false);
  const generation = useRef(0);

  const read = useCallback(
    async (path: string, init?: RequestInit) => {
      const response = await request(`/api/quant-emulator/${path}`, init);
      const answer = await response.json();
      if (!response.ok)
        throw new Error(
          `HTTP ${response.status}: ${typeof answer?.detail === "string" ? answer.detail : "Evaluation request failed."}`,
        );
      return answer;
    },
    [request],
  );

  const list = useCallback(async () => {
    const answer = await read("tasks");
    if (!Array.isArray(answer.tasks))
      throw new Error("Stored evaluation list could not be read.");
    setTasks(answer.tasks);
  }, [read]);

  useEffect(() => {
    let mounted = true;
    const lifecycle = generation;
    void read("tasks")
      .then((answer) => {
        if (!Array.isArray(answer.tasks))
          throw new Error("Stored evaluation list could not be read.");
        if (mounted) setTasks(answer.tasks);
      })
      .catch((caught) => {
        if (mounted)
          setError(
            caught instanceof Error ? caught.message : "History unavailable.",
          );
      });
    return () => {
      mounted = false;
      lifecycle.current++;
    };
  }, [read]);

  async function loadBundle() {
    setBusy(true);
    setError("");
    try {
      // Explicit sample mode, never a silent fallback from a stored/live cycle.
      const answer = await read("bundle?mode=sample");
      if (
        typeof answer.prompt !== "string" ||
        !answer.prompt ||
        !row(answer.pinned_identities).bars_hash
      )
        throw new Error("The sample bundle could not be read.");
      setBundle(answer);
    } catch (caught) {
      setBundle(null);
      setError(
        caught instanceof Error ? caught.message : "Bundle unavailable.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function open(id: string) {
    generation.current++;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setActive(await read(`tasks/${encodeURIComponent(id)}`));
    } catch (caught) {
      setActive(null);
      setError(
        caught instanceof Error
          ? caught.message
          : "Stored evaluation unavailable.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (!bundle || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const current = ++generation.current;
    try {
      // One POST only. Neither network failure nor polling replays this mutation.
      let task: Task = await read("tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: bundle.prompt,
          feature_key: "quant_eval",
        }),
      });
      setActive(task);
      setTasks((previous) => [
        task,
        ...previous.filter((item) => item.id !== task.id),
      ]);
      for (
        let attempt = 0;
        !terminal(task.status) && attempt < 120;
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        if (generation.current !== current) return;
        task = await read(`tasks/${encodeURIComponent(task.id)}`);
        if (generation.current !== current) return;
        setActive(task);
      }
      if (!terminal(task.status))
        setNotice(
          "Stopped automatic refresh after ten minutes. Reopen this stored run to check its status; no new run was started.",
        );
      await list();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Evaluation failed. No retry was sent.",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const result = row(active?.quant_result);
  const items = evaluations(active?.quant_result);
  return (
    <section className="qe-workspace" aria-label="Admin quant emulator">
      <div className="qe-panel">
        <p className="eyebrow">
          <FlaskConical size={16} /> SYNTHETIC SAMPLE · PAPER ONLY
        </p>
        <h2>Test a pinned strategy evaluation.</h2>
        <p className="muted">
          Uses the customer emulator’s sample bundle and stored quant-task APIs.
          Figures are reported by the HarnessRouter agent. The API stores its
          answer and does not recompute or independently verify the metrics with
          finance_core.
        </p>
        <div className="qe-actions">
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void loadBundle()}
          >
            <Database size={16} />
            Load sample bundle
          </button>
          <button
            className="button primary"
            disabled={
              busy || !bundle || Boolean(active && !terminal(active.status))
            }
            onClick={() => void run()}
          >
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Play size={16} />
            )}
            Run sample evaluation
          </button>
        </div>
        <p className="muted">
          One run per click. No automatic retry, jobs, orders or follow-up
          actions. Results are stored under the signed-in administrator’s own
          account.
        </p>
        {bundle && (
          <details open>
            <summary>Input bundle · mode=sample</summary>
            <Identity value={bundle.pinned_identities} />
            <details>
              <summary>Exact submitted prompt</summary>
              <pre>{bundle.prompt}</pre>
            </details>
          </details>
        )}
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="success" role="status">
          {notice}
        </div>
      )}
      <div className="qe-columns">
        <aside className="qe-panel">
          <div className="qe-actions">
            <h2>Stored runs</h2>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => {
                setError("");
                void list().catch((caught) => setError(String(caught)));
              }}
            >
              <RefreshCw size={15} />
              Refresh history
            </button>
          </div>
          <p className="muted">
            Reopen fetches the stored task again from the server.
          </p>
          {tasks.length === 0 && <p>No stored quant runs loaded.</p>}
          {tasks.map((task) => (
            <button
              className={`qe-history ${active?.id === task.id ? "selected" : ""}`}
              key={task.id}
              disabled={busy}
              onClick={() => void open(task.id)}
            >
              <strong>{task.status}</strong>
              <span>{task.created_at}</span>
              <code>{task.id}</code>
            </button>
          ))}
        </aside>
        <div className="qe-panel" aria-live="polite">
          <h2>Stored agent answer</h2>
          {!active ? (
            <p className="muted">
              Load a sample or reopen a run to inspect its stored answer.
            </p>
          ) : (
            <>
              <dl className="qe-identities">
                <div>
                  <dt>Task ID</dt>
                  <dd>{active.id}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{active.status}</dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>{active.created_at}</dd>
                </div>
                <div>
                  <dt>Updated</dt>
                  <dd>{active.updated_at}</dd>
                </div>
              </dl>
              {!terminal(active.status) && (
                <AdminQuantProgressCard key={active.id} />
              )}
              <p>{formatCleanQuantScope(active.query)}</p>
              {active.incomplete_reason && (
                <p className="error">{active.incomplete_reason}</p>
              )}
              <p>
                <strong>Agent simulation_label:</strong>{" "}
                {reported(result.simulation_label)}
              </p>
              {items === null ? (
                <p>
                  {terminal(active.status)
                    ? "The stored answer did not parse as a quant evaluation. No rankings are inferred."
                    : "Waiting for a stored agent answer."}
                </p>
              ) : (
                <>
                  <p>
                    <strong>Agent result status:</strong>{" "}
                    {reported(result.status)}
                  </p>
                  {items.length === 0 && (
                    <p>The agent returned no evaluations.</p>
                  )}
                  {items.map((item, index) => (
                    <section className="qe-evaluation" key={index}>
                      <h3>
                        {reported(item.symbol)} · {reported(item.cycle_id)}
                      </h3>
                      <h4>Identities reported by the agent</h4>
                      <Identity value={item.pinned_identities} />
                      <div className="qe-winners">
                        <p>
                          Stable winner
                          <strong>{reported(item.stable_winner)}</strong>
                        </p>
                        <p>
                          Aggressive winner
                          <strong>{reported(item.aggressive_winner)}</strong>
                        </p>
                      </div>
                      <h4>Candidate metrics, as reported</h4>
                      <p className="muted">
                        Returns and drawdowns are raw ratios; Sharpe is
                        unitless. Source order is retained.
                      </p>
                      <div className="qe-table">
                        <table>
                          <thead>
                            <tr>
                              {[
                                "Model",
                                "Selection return",
                                "Selection Sharpe",
                                "Selection drawdown",
                                "Confirmation return",
                                "Confirmation Sharpe",
                                "Confirmation drawdown",
                              ].map((label) => (
                                <th key={label} scope="col">
                                  {label}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {candidates(item.candidate_metrics).map(
                              (candidate, i) => (
                                <tr key={i}>
                                  <th scope="row">{reported(candidate.id)}</th>
                                  {candidate.values.map((value, j) => (
                                    <td key={j}>{reported(value)}</td>
                                  ))}
                                </tr>
                              ),
                            )}
                          </tbody>
                        </table>
                      </div>
                      <details>
                        <summary>
                          Baseline, reasons and complete reported evaluation
                        </summary>
                        <pre>{JSON.stringify(item, null, 2)}</pre>
                      </details>
                    </section>
                  ))}
                  <details>
                    <summary>Reported issues</summary>
                    <pre>{JSON.stringify(result.issues ?? null, null, 2)}</pre>
                  </details>
                </>
              )}
              <details>
                <summary>Exact stored answer</summary>
                <pre>{active.answer || "No answer returned."}</pre>
              </details>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
