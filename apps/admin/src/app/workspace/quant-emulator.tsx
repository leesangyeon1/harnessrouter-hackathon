"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Database,
  FlaskConical,
  LoaderCircle,
  Play,
  RefreshCw,
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
              <p>{active.query}</p>
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
