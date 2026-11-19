"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  FileText,
  LoaderCircle,
  MessageSquarePlus,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import type { AgentTask, FinanceApi } from "@/lib/api";
import "./ticker-verifier.css";

const PRESETS = [
  "Verify TLT and IEF bond ETFs with issuer and exchange listing",
  "Verify BTC/USD cryptocurrency pair on a major USD venue",
  "Identify Apple Inc. primary US stock ticker and listing exchange",
];

function isTerminal(status: AgentTask["status"]): boolean {
  return (
    status === "completed" ||
    status === "incomplete" ||
    status === "failed" ||
    status === "cancelled"
  );
}

function formatDetailBlock(value: Record<string, unknown> | string | null): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return Object.entries(value)
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ");
}

export function TickerVerifier({
  api,
  demo,
  onRequireSignIn,
}: {
  api: FinanceApi | null;
  demo: boolean;
  onRequireSignIn: () => void;
}) {
  const [queryInput, setQueryInput] = useState("");
  const [followUpInput, setFollowUpInput] = useState("");
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [activeTask, setActiveTask] = useState<AgentTask | null>(null);
  const [activityLabel, setActivityLabel] = useState("Starting verification…");
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
      setActivityLabel("Connecting to verification agent…");
      setStreamDelta("");

      try {
        await client.streamAgentTaskEvents(
          task.id,
          (ev) => {
            if (ev.kind === "activity") {
              setActivityLabel(ev.label);
            } else if (ev.kind === "text") {
              setStreamDelta((prev) => (prev + ev.delta).slice(-1200));
            }
          },
          abort.signal,
        );
      } catch {
        /* Fallback polling below resolves final state if stream disconnects */
      }

      while (!abort.signal.aborted) {
        try {
          const refreshed = await client.getAgentTask(task.id);
          setActiveTask(refreshed);
          upsertTaskList(refreshed);
          if (isTerminal(refreshed.status)) {
            if (refreshed.status === "failed" || refreshed.status === "cancelled") {
              setStreamDelta("");
            }
            break;
          }
        } catch (caught) {
          if (!abort.signal.aborted) {
            setError(
              caught instanceof Error
                ? caught.message
                : "Verification status could not be refreshed.",
            );
          }
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    },
    [upsertTaskList],
  );

  useEffect(() => {
    if (!api || demo) return;
    let cancelled = false;
    void api
      .listAgentTasks("search")
      .then((loaded) => {
        if (cancelled) return;
        setTasks(loaded);
        if (loaded.length > 0) {
          setActiveTask(loaded[0]);
          if (!isTerminal(loaded[0].status)) {
            void watchTask(api, loaded[0]);
          }
        }
      })
      .catch(() => {
        /* History stays empty on transient read failure */
      });
    return () => {
      cancelled = true;
      streamAbortRef.current?.abort();
    };
  }, [api, demo, watchTask]);

  async function submitNewTask(event: FormEvent) {
    event.preventDefault();
    if (demo || !api) {
      onRequireSignIn();
      return;
    }
    const trimmed = queryInput.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await api.startAgentTask(trimmed, {
        featureKey: "search",
      });
      setQueryInput("");
      setActiveTask(created);
      upsertTaskList(created);
      void watchTask(api, created);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The verification request could not be started.",
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
        featureKey: "search",
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
          : "Your follow-up could not be sent.",
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
          : "The task could not be cancelled.",
      );
    }
  }

  const running = Boolean(activeTask && !isTerminal(activeTask.status));
  const structured = activeTask?.structured_result ?? null;

  return (
    <div className="ticker-verifier">
      <section className="panel verifier-compose">
        <div>
          <span className="eyebrow">HERMES RESEARCH AGENT · READ-ONLY PUBLIC SOURCES</span>
          <h2>Verify stocks, bond ETFs, equity ETFs, and crypto USD pairs</h2>
          <p className="small muted">
            Confirm symbols, exchanges, fund share classes, and actual USD pairs
            against authoritative public filings and exchange pages. Supported
            bond ETFs include TLT, IEF, SHY, LQD, HYG, BND, and TIP.
          </p>
        </div>

        <form className="verifier-form" onSubmit={(e) => void submitNewTask(e)}>
          <input
            type="text"
            aria-label="Instrument or symbol verification query"
            placeholder="Ask to identify or verify tickers (e.g., Verify TLT, LQD, and BTC/USD)…"
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            disabled={submitting}
          />
          <button
            type="submit"
            className="button primary"
            disabled={submitting || (!demo && !queryInput.trim())}
          >
            {submitting ? (
              <>
                <LoaderCircle size={16} className="spin" />
                Starting…
              </>
            ) : demo ? (
              <>
                Sign in to verify
                <ArrowRight size={15} />
              </>
            ) : (
              <>
                <Sparkles size={16} />
                Verify instruments
              </>
            )}
          </button>
        </form>

        <div className="verifier-presets">
          {PRESETS.map((sample) => (
            <button
              key={sample}
              type="button"
              className="verifier-chip"
              onClick={() => setQueryInput(sample)}
            >
              {sample}
            </button>
          ))}
        </div>
      </section>

      {error && (
        <div className="error-banner" role="alert">
          <CircleAlert size={16} />
          <span>{error}</span>
          <button
            className="icon-button"
            aria-label="Dismiss verification error"
            onClick={() => setError(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}

      {running && activeTask && (
        <section className="panel verifier-progress" role="status">
          <div className="verifier-progress-top">
            <span className="verifier-progress-status">
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
            Request: <strong>{activeTask.query}</strong> (public source lookups
            can take up to a minute)
          </p>
          {streamDelta && (
            <pre className="verifier-stream-preview">{streamDelta}</pre>
          )}
        </section>
      )}

      {activeTask && isTerminal(activeTask.status) && (
        <section className="panel">
          <div className="card-heading">
            <div>
              <span className="eyebrow">VERIFICATION RESULT</span>
              <h2>{activeTask.query}</h2>
            </div>
            <span
              className={`pill ${
                activeTask.status === "completed" &&
                structured?.status === "ok"
                  ? "positive-pill"
                  : "neutral-pill"
              }`}
            >
              {structured?.status
                ? `Status: ${structured.status}`
                : activeTask.status}
            </span>
          </div>

          {activeTask.status === "failed" && (
            <p className="coral-text small">
              This verification could not be completed. Please try again with a
              new request.
            </p>
          )}

          {activeTask.status === "cancelled" && (
            <p className="muted small">This verification was cancelled.</p>
          )}

          {activeTask.status === "incomplete" && (
            <div className="verifier-clarification" style={{ marginBottom: 12 }}>
              This verification paused early (
              {activeTask.incomplete_reason ?? "budget limit"}). Partial
              findings are shown below; send a follow-up to continue.
            </div>
          )}

          {structured ? (
            <>
              {structured.clarification && (
                <div className="verifier-clarification">
                  <strong>Clarification needed:</strong>{" "}
                  {structured.clarification}
                </div>
              )}

              {structured.results.length > 0 ? (
                <div className="verifier-results-grid">
                  {structured.results.map((item, idx) => {
                    const quoteStr = formatDetailBlock(item.quote);
                    const screenStr = formatDetailBlock(item.screening_evidence);
                    return (
                      <article
                        className="verifier-card"
                        key={`${item.symbol ?? "item"}-${idx}`}
                      >
                        <div className="verifier-card-head">
                          <div>
                            <div className="verifier-symbol">
                              {item.symbol ?? "Unresolved symbol"}
                            </div>
                            <div className="small muted">
                              {item.name ?? "Name unavailable"}
                            </div>
                          </div>
                          <span
                            className={`pill ${
                              item.verification_status === "verified"
                                ? "positive-pill"
                                : "neutral-pill"
                            }`}
                          >
                            {item.verification_status === "verified" && (
                              <CheckCircle2 size={12} />
                            )}
                            {item.verification_status ?? "unverified"}
                          </span>
                        </div>

                        <dl className="verifier-meta-dl">
                          <div>
                            <dt>Asset type</dt>
                            <dd>{item.asset_type ?? "—"}</dd>
                          </div>
                          <div>
                            <dt>Exchange / venue</dt>
                            <dd>{item.exchange_or_venue ?? "—"}</dd>
                          </div>
                          <div>
                            <dt>Quote currency</dt>
                            <dd>{item.quote_currency ?? "—"}</dd>
                          </div>
                          <div>
                            <dt>Citations</dt>
                            <dd>{item.citations?.length ?? 0}</dd>
                          </div>
                        </dl>

                        {quoteStr && (
                          <p className="small">
                            <strong>Quote:</strong> {quoteStr}
                          </p>
                        )}
                        {screenStr && (
                          <p className="small">
                            <strong>Screening evidence:</strong> {screenStr}
                          </p>
                        )}

                        {Array.isArray(item.citations) &&
                          item.citations.length > 0 && (
                            <div className="verifier-citations">
                              <strong className="small">Sources</strong>
                              {item.citations.map((cit, cIdx) => {
                                const href = cit.URL ?? cit.url ?? "";
                                const safeHref = href.startsWith("https://")
                                  ? href
                                  : "";
                                const title =
                                  cit.source_title ??
                                  cit.title ??
                                  (safeHref || "Public source");
                                return (
                                  <div
                                    className="verifier-citation-item"
                                    key={`${title}-${cIdx}`}
                                  >
                                    {safeHref ? (
                                      <a
                                        href={safeHref}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="verifier-citation-link"
                                      >
                                        {title}
                                        <ExternalLink size={12} />
                                      </a>
                                    ) : (
                                      <strong>{title}</strong>
                                    )}
                                    {Array.isArray(cit.supported_facts) &&
                                      cit.supported_facts.length > 0 && (
                                        <ul className="verifier-facts">
                                          {cit.supported_facts.map(
                                            (fact, fIdx) => (
                                              <li key={fIdx}>{fact}</li>
                                            ),
                                          )}
                                        </ul>
                                      )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                      </article>
                    );
                  })}
                </div>
              ) : (
                !structured.clarification && (
                  <p className="small muted" style={{ marginTop: 10 }}>
                    No matching verified instruments were returned for this
                    request.
                  </p>
                )
              )}

              {Array.isArray(structured.limitations) &&
                structured.limitations.length > 0 && (
                  <div style={{ marginTop: 14 }}>
                    <strong className="small">Disclosures &amp; limitations</strong>
                    <ul className="verifier-facts">
                      {structured.limitations.map((lim, idx) => (
                        <li key={idx} className="small muted">
                          {lim}
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
                className="verifier-stream-preview"
                style={{ maxHeight: 320, marginTop: 12 }}
              >
                {activeTask.answer}
              </pre>
            )
          )}

          {activeTask.files.length > 0 && api && (
            <div className="verifier-files">
              <h3>Generated files</h3>
              {activeTask.files.map((file) => (
                <div className="verifier-file-row" key={file.path}>
                  <span>
                    <FileText size={15} />{" "}
                    <strong>{file.filename}</strong>{" "}
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
            <div className="verifier-files">
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
                className="verifier-iframe"
                src={api.previewFullUrl(activeTask.preview_url)}
                sandbox="allow-scripts allow-forms"
                referrerPolicy="no-referrer"
                title="Sandboxed verification preview"
              />
            </div>
          )}

          {activeTask.can_continue && !demo && (
            <form
              className="verifier-form"
              style={{ marginTop: 16 }}
              onSubmit={(e) => void submitFollowUp(e)}
            >
              <input
                type="text"
                aria-label="Follow up on this verification result"
                placeholder="Follow up or answer clarification on this result…"
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
                Continue this result
              </button>
            </form>
          )}
        </section>
      )}

      {!demo && tasks.length > 0 && (
        <section className="panel">
          <div className="card-heading">
            <h2>Your verification history</h2>
            {api && (
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  void api
                    .listAgentTasks("search")
                    .then((list) => setTasks(list))
                }
              >
                <RefreshCw size={14} />
                Refresh
              </button>
            )}
          </div>
          <div className="verifier-history-list">
            {tasks.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`verifier-history-item ${
                  activeTask?.id === item.id ? "selected" : ""
                }`}
                onClick={() => {
                  setActiveTask(item);
                  if (api && !isTerminal(item.status)) {
                    void watchTask(api, item);
                  }
                }}
              >
                <span>
                  <strong>{item.query}</strong>
                  <span className="small muted" style={{ display: "block" }}>
                    {new Date(item.created_at).toLocaleString()}
                    {item.parent_task_id ? " · Follow-up" : ""}
                  </span>
                </span>
                <span className="pill neutral-pill">
                  {item.structured_result?.status ?? item.status}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
