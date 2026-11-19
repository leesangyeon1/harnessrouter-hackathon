"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Calculator,
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
import {
  ADVISOR_PRESETS,
  computeBalanceTransferComparison,
  computeRefinanceComparison,
} from "@/lib/calculator";
import { AgentRunProgress, ReportCompletedBar } from "./agent-progress";
import "./finance-advisor.css";

function parseUsdAmount(formatted: string): number {
  const cleaned = Number(formatted.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(cleaned) && cleaned > 0 ? cleaned : 0;
}

function detectAdvisorSectionPills(markdown: string): string[] {
  const lower = markdown.toLowerCase();
  const found: string[] = [];
  if (lower.includes("summary")) found.push("Summary");
  if (lower.includes("input") || lower.includes("verif"))
    found.push("Inputs & Verification");
  if (lower.includes("comparison") || markdown.includes("|"))
    found.push("Comparison Table");
  if (lower.includes("tradeoff") || lower.includes("recommend"))
    found.push("Tradeoffs & Recommendation");
  if (lower.includes("next step") || lower.includes("missing"))
    found.push("Next Steps");
  return found.length > 0
    ? found
    : ["Verified Analysis", "Structured Report"];
}

function isTerminal(status: AgentTask["status"]): boolean {
  return (
    status === "completed" ||
    status === "incomplete" ||
    status === "failed" ||
    status === "cancelled"
  );
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return tokens.map((part, idx) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={idx}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={idx}>{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

function parseTableCells(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|") && !trimmed.includes("-")) return false;
  const cells = parseTableCells(trimmed);
  return (
    cells.length > 0 &&
    cells.every((cell) => /^:?-{2,}:?$/.test(cell))
  );
}

function renderAdvisorMarkdown(markdown: string): ReactNode {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const elements: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // Markdown heading (render top sections as h3 under card h2 for strict WCAG heading order)
    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = renderInlineMarkdown(headingMatch[2].trim());
      if (level <= 2) {
        elements.push(<h3 key={`h-${i}`}>{content}</h3>);
      } else {
        elements.push(<h4 key={`h-${i}`}>{content}</h4>);
      }
      i++;
      continue;
    }

    // GitHub-flavored Markdown table
    if (
      trimmed.includes("|") &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      const headers = parseTableCells(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().includes("|")) {
        if (!isTableSeparator(lines[i])) {
          rows.push(parseTableCells(lines[i]));
        }
        i++;
      }
      elements.push(
        <div
          key={`tbl-${i}`}
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Advisor comparison table"
        >
          <table>
            <thead>
              <tr>
                {headers.map((h, hIdx) => (
                  <th key={hIdx}>{renderInlineMarkdown(h)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, rIdx) => (
                <tr key={rIdx}>
                  {headers.map((_, cIdx) => (
                    <td key={cIdx}>{renderInlineMarkdown(r[cIdx] ?? "—")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Unordered list
    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ""));
        i++;
      }
      elements.push(
        <ul key={`ul-${i}`}>
          {items.map((item, idx) => (
            <li key={idx}>{renderInlineMarkdown(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ""));
        i++;
      }
      elements.push(
        <ol key={`ol-${i}`}>
          {items.map((item, idx) => (
            <li key={idx}>{renderInlineMarkdown(item)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // Paragraph
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,4}|\d+\.|[-*])\s+/.test(lines[i].trim()) &&
      !(
        lines[i].trim().includes("|") &&
        i + 1 < lines.length &&
        isTableSeparator(lines[i + 1])
      )
    ) {
      paraLines.push(lines[i].trim());
      i++;
    }
    elements.push(
      <p key={`p-${i}`}>{renderInlineMarkdown(paraLines.join(" "))}</p>,
    );
  }

  return <div className="advisor-markdown">{elements}</div>;
}

function summarizeQueryTitle(raw: string): string {
  const goalLine = raw
    .split("\n")
    .find((line) => line.toLowerCase().startsWith("user comparison goal:"));
  if (goalLine) {
    return goalLine.slice("user comparison goal:".length).trim();
  }
  const firstNonEmpty = raw
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  return firstNonEmpty ?? "Financial comparison";
}

export function FinanceAdvisor({
  api,
  demo,
  onRequireSignIn,
}: {
  api: FinanceApi | null;
  demo: boolean;
  onRequireSignIn: () => void;
}) {
  const promptFieldId = useId();
  const followUpFieldId = useId();

  const [promptInput, setPromptInput] = useState("");
  const [followUpInput, setFollowUpInput] = useState("");
  const [showCalculator, setShowCalculator] = useState(false);
  const [calcMode, setCalcMode] = useState<"card" | "refi">("card");

  // Card vs Balance Transfer calculator state
  const [cardBalance, setCardBalance] = useState("2387.65");
  const [cardApr, setCardApr] = useState("24.49");
  const [cardMonthly, setCardMonthly] = useState("200");
  const [transferFee, setTransferFee] = useState("3.0");
  const [promoMonths, setPromoMonths] = useState("15");
  const [postPromoApr, setPostPromoApr] = useState("21.99");

  // Loan Refinance calculator state
  const [loanPrincipal, setLoanPrincipal] = useState("18500");
  const [loanApr, setLoanApr] = useState("6.80");
  const [loanMonthsLeft, setLoanMonthsLeft] = useState("48");
  const [refiApr, setRefiApr] = useState("5.10");
  const [refiTermMonths, setRefiTermMonths] = useState("48");
  const [refiFee, setRefiFee] = useState("185");

  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [activeTask, setActiveTask] = useState<AgentTask | null>(null);
  const [activityLabel, setActivityLabel] = useState(
    "Starting financial analysis…",
  );
  const [streamDelta, setStreamDelta] = useState("");
  const [eventCount, setEventCount] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);

  const cardCalcPreview = useMemo(
    () =>
      computeBalanceTransferComparison({
        balanceUsd: Math.max(0, Number(cardBalance) || 0),
        currentAprPct: Math.max(0, Number(cardApr) || 0),
        monthlyPaymentUsd: Math.max(0, Number(cardMonthly) || 0),
        transferFeePct: Math.max(0, Number(transferFee) || 0),
        promoAprPct: 0,
        promoMonths: Math.max(1, Math.round(Number(promoMonths) || 1)),
        postPromoAprPct: Math.max(0, Number(postPromoApr) || 0),
        goal: "Minimize total repayment cost while keeping monthly payments predictable.",
      }),
    [
      cardBalance,
      cardApr,
      cardMonthly,
      transferFee,
      promoMonths,
      postPromoApr,
    ],
  );

  const refiCalcPreview = useMemo(
    () =>
      computeRefinanceComparison({
        principalUsd: Math.max(0, Number(loanPrincipal) || 0),
        currentAprPct: Math.max(0, Number(loanApr) || 0),
        remainingMonths: Math.max(1, Math.round(Number(loanMonthsLeft) || 1)),
        newAprPct: Math.max(0, Number(refiApr) || 0),
        newTermMonths: Math.max(1, Math.round(Number(refiTermMonths) || 1)),
        refiFeeUsd: Math.max(0, Number(refiFee) || 0),
        goal: "Compare monthly payment relief against total lifetime cost including fees.",
      }),
    [loanPrincipal, loanApr, loanMonthsLeft, refiApr, refiTermMonths, refiFee],
  );

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
      setActivityLabel("Connecting to finance advisor…");
      setStreamDelta("");
      setEventCount(0);

      try {
        await client.streamAgentTaskEvents(
          task.id,
          (ev) => {
            if (ev.kind === "activity") {
              setActivityLabel(ev.label);
              setEventCount((prev) => prev + 1);
            } else if (ev.kind === "text") {
              setStreamDelta((prev) => (prev + ev.delta).slice(-1400));
            }
          },
          abort.signal,
        );
      } catch {
        /* Fallback polling below resolves terminal state on stream disconnect */
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
                : "Analysis status could not be refreshed.",
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
      .listAgentTasks("advisor")
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
        /* Keep empty history on transient error */
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
    const trimmed = promptInput.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await api.startAgentTask(trimmed, {
        featureKey: "advisor",
      });
      setPromptInput("");
      setActiveTask(created);
      upsertTaskList(created);
      void watchTask(api, created);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Your analysis request could not be started.",
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
        featureKey: "advisor",
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
          : "The analysis could not be cancelled.",
      );
    }
  }

  const running = Boolean(activeTask && !isTerminal(activeTask.status));

  return (
    <div className="finance-advisor">
      <section className="panel advisor-hero-panel">
        <div className="advisor-header-row">
          <div>
            <span className="eyebrow">
              PERSONAL FINANCE ADVISOR · VERIFIED SCENARIO COMPARISON
            </span>
            <h2>Compare credit cards, debt payoff, and refinancing tradeoffs</h2>
            <p className="small muted">
              Analyze normalized balances, APRs, fees, and verified calculator
              outputs—distinguishing lower monthly payments from lower total
              lifetime costs, with private per-user memory across sessions.
            </p>
          </div>
          <div className="advisor-badges">
            <button
              type="button"
              className="button secondary"
              onClick={() => setShowCalculator((prev) => !prev)}
              aria-expanded={showCalculator}
            >
              <Calculator size={15} />
              {showCalculator ? "Hide calculator" : "Verified calculator"}
            </button>
          </div>
        </div>

        {showCalculator && (
          <div className="advisor-calc-box">
            <div className="segmented small-segment">
              <button
                type="button"
                className={calcMode === "card" ? "selected" : ""}
                aria-pressed={calcMode === "card"}
                onClick={() => setCalcMode("card")}
              >
                Card vs. Balance transfer
              </button>
              <button
                type="button"
                className={calcMode === "refi" ? "selected" : ""}
                aria-pressed={calcMode === "refi"}
                onClick={() => setCalcMode("refi")}
              >
                Loan refinancing
              </button>
            </div>

            {calcMode === "card" ? (
              <>
                <div className="advisor-calc-grid">
                  <label className="advisor-field">
                    Balance (USD)
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={cardBalance}
                      onChange={(e) => setCardBalance(e.target.value)}
                    />
                  </label>
                  <label className="advisor-field">
                    Current APR (%)
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={cardApr}
                      onChange={(e) => setCardApr(e.target.value)}
                    />
                  </label>
                  <label className="advisor-field">
                    Monthly payment ($)
                    <input
                      type="number"
                      step="1"
                      min="1"
                      value={cardMonthly}
                      onChange={(e) => setCardMonthly(e.target.value)}
                    />
                  </label>
                  <label className="advisor-field">
                    Transfer fee (%)
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      value={transferFee}
                      onChange={(e) => setTransferFee(e.target.value)}
                    />
                  </label>
                  <label className="advisor-field">
                    0% Promo months
                    <input
                      type="number"
                      step="1"
                      min="1"
                      value={promoMonths}
                      onChange={(e) => setPromoMonths(e.target.value)}
                    />
                  </label>
                  <label className="advisor-field">
                    Post-promo APR (%)
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={postPromoApr}
                      onChange={(e) => setPostPromoApr(e.target.value)}
                    />
                  </label>
                </div>
                {(() => {
                  const curVal = parseUsdAmount(
                    cardCalcPreview.optionCurrent.totalCostUsd,
                  );
                  const trfVal = parseUsdAmount(
                    cardCalcPreview.optionTransfer.totalCostUsd,
                  );
                  const maxVal = Math.max(1, curVal, trfVal);
                  return curVal > 0 && trfVal > 0 ? (
                    <div className="calc-visual-bars">
                      <div className="calc-bar-row">
                        <div className="calc-bar-label-line">
                          <span>Current card total cost</span>
                          <strong>
                            {cardCalcPreview.optionCurrent.totalCostUsd}
                          </strong>
                        </div>
                        <div className="metric-mini-track">
                          <div
                            className={`metric-mini-fill ${
                              curVal <= trfVal ? "good" : "warn"
                            }`}
                            style={{
                              width: `${Math.round((curVal / maxVal) * 100)}%`,
                            }}
                          />
                        </div>
                      </div>
                      <div className="calc-bar-row">
                        <div className="calc-bar-label-line">
                          <span>0% Balance transfer total cost</span>
                          <strong>
                            {cardCalcPreview.optionTransfer.totalCostUsd}
                          </strong>
                        </div>
                        <div className="metric-mini-track">
                          <div
                            className={`metric-mini-fill ${
                              trfVal <= curVal ? "good" : "warn"
                            }`}
                            style={{
                              width: `${Math.round((trfVal / maxVal) * 100)}%`,
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  ) : null;
                })()}
                <div className="advisor-calc-summary">
                  <span>
                    Verified preview: Current total{" "}
                    <strong>{cardCalcPreview.optionCurrent.totalCostUsd}</strong>{" "}
                    vs. Transfer total{" "}
                    <strong>
                      {cardCalcPreview.optionTransfer.totalCostUsd}
                    </strong>{" "}
                    (Savings:{" "}
                    <strong>
                      {cardCalcPreview.netCostSavingsUsd ?? "N/A"}
                    </strong>
                    )
                  </span>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => {
                      setPromptInput(cardCalcPreview.formattedPrompt);
                      setShowCalculator(false);
                    }}
                  >
                    Insert verified scenario
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="advisor-calc-grid">
                  <label className="advisor-field">
                    Principal (USD)
                    <input
                      type="number"
                      step="1"
                      min="0"
                      value={loanPrincipal}
                      onChange={(e) => setLoanPrincipal(e.target.value)}
                    />
                  </label>
                  <label className="advisor-field">
                    Current APR (%)
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={loanApr}
                      onChange={(e) => setLoanApr(e.target.value)}
                    />
                  </label>
                  <label className="advisor-field">
                    Months left
                    <input
                      type="number"
                      step="1"
                      min="1"
                      value={loanMonthsLeft}
                      onChange={(e) => setLoanMonthsLeft(e.target.value)}
                    />
                  </label>
                  <label className="advisor-field">
                    New APR (%)
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={refiApr}
                      onChange={(e) => setRefiApr(e.target.value)}
                    />
                  </label>
                  <label className="advisor-field">
                    New term (months)
                    <input
                      type="number"
                      step="1"
                      min="1"
                      value={refiTermMonths}
                      onChange={(e) => setRefiTermMonths(e.target.value)}
                    />
                  </label>
                  <label className="advisor-field">
                    Closing fee ($)
                    <input
                      type="number"
                      step="1"
                      min="0"
                      value={refiFee}
                      onChange={(e) => setRefiFee(e.target.value)}
                    />
                  </label>
                </div>
                {(() => {
                  const curLoanVal = parseUsdAmount(
                    refiCalcPreview.currentLoan.totalOutOfPocketUsd,
                  );
                  const refiLoanVal = parseUsdAmount(
                    refiCalcPreview.refiOffer.totalOutOfPocketUsd,
                  );
                  const maxLoanVal = Math.max(1, curLoanVal, refiLoanVal);
                  return curLoanVal > 0 && refiLoanVal > 0 ? (
                    <div className="calc-visual-bars">
                      <div className="calc-bar-row">
                        <div className="calc-bar-label-line">
                          <span>Current loan remaining out-of-pocket</span>
                          <strong>
                            {refiCalcPreview.currentLoan.totalOutOfPocketUsd} (
                            {refiCalcPreview.currentLoan.monthlyPaymentUsd}/mo)
                          </strong>
                        </div>
                        <div className="metric-mini-track">
                          <div
                            className={`metric-mini-fill ${
                              curLoanVal <= refiLoanVal ? "good" : "warn"
                            }`}
                            style={{
                              width: `${Math.round(
                                (curLoanVal / maxLoanVal) * 100,
                              )}%`,
                            }}
                          />
                        </div>
                      </div>
                      <div className="calc-bar-row">
                        <div className="calc-bar-label-line">
                          <span>Refinance offer total out-of-pocket</span>
                          <strong>
                            {refiCalcPreview.refiOffer.totalOutOfPocketUsd} (
                            {refiCalcPreview.refiOffer.monthlyPaymentUsd}/mo)
                          </strong>
                        </div>
                        <div className="metric-mini-track">
                          <div
                            className={`metric-mini-fill ${
                              refiLoanVal <= curLoanVal ? "good" : "warn"
                            }`}
                            style={{
                              width: `${Math.round(
                                (refiLoanVal / maxLoanVal) * 100,
                              )}%`,
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  ) : null;
                })()}
                <div className="advisor-calc-summary">
                  <span>
                    Verified preview: Monthly Δ{" "}
                    <strong>{refiCalcPreview.monthlyPaymentDeltaUsd}</strong> ·
                    Lifetime net savings{" "}
                    <strong>{refiCalcPreview.netTotalSavingsUsd}</strong>
                  </span>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => {
                      setPromptInput(refiCalcPreview.formattedPrompt);
                      setShowCalculator(false);
                    }}
                  >
                    Insert verified scenario
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        <form className="advisor-form" onSubmit={(e) => void submitNewTask(e)}>
          <label htmlFor={promptFieldId} className="sr-only">
            Financial comparison request and verified calculator inputs
          </label>
          <textarea
            id={promptFieldId}
            className="advisor-textarea"
            placeholder="Load a verified scenario preset below, use the calculator, or enter your normalized balances, APRs, terms, fees, comparison goal, and verified calculator figures…"
            value={promptInput}
            onChange={(e) => setPromptInput(e.target.value)}
            disabled={submitting}
          />
          <div className="advisor-actions-bar">
            <div className="advisor-Presets-row">
              {ADVISOR_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="advisor-chip"
                  onClick={() => setPromptInput(preset.prompt)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <button
              type="submit"
              className="button primary"
              disabled={submitting || (!demo && !promptInput.trim())}
            >
              {submitting ? (
                <>
                  <LoaderCircle size={16} className="spin" />
                  Starting…
                </>
              ) : demo ? (
                <>
                  Sign in to analyze
                  <ArrowRight size={15} />
                </>
              ) : (
                <>
                  <Sparkles size={16} />
                  Analyze options
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
            aria-label="Dismiss advisor error"
            onClick={() => setError(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}

      {running && activeTask && (
        <AgentRunProgress
          key={activeTask.id}
          variant="advisor"
          activityLabel={activityLabel}
          queryTitle={summarizeQueryTitle(activeTask.query)}
          streamChars={streamDelta.length}
          eventCount={eventCount}
          onCancel={() => void cancelActive()}
        />
      )}

      {activeTask && isTerminal(activeTask.status) && (
        <section
          className="panel report-reveal-panel"
          key={`report-${activeTask.id}-${activeTask.status}`}
        >
          <div className="card-heading">
            <div>
              <span className="eyebrow">ADVISOR COMPARISON REPORT</span>
              <h2>{summarizeQueryTitle(activeTask.query)}</h2>
            </div>
            <span
              className={`pill ${
                activeTask.status === "completed"
                  ? "positive-pill"
                  : "neutral-pill"
              }`}
            >
              {activeTask.status === "completed" && <CheckCircle2 size={12} />}
              {activeTask.status}
            </span>
          </div>

          {activeTask.status === "completed" && activeTask.answer && (
            <ReportCompletedBar
              label="Verified financial comparison report complete"
              pills={detectAdvisorSectionPills(activeTask.answer)}
            />
          )}

          {activeTask.status === "failed" && (
            <p className="coral-text small">
              This financial analysis could not be completed right now. Please
              try again with a new request.
            </p>
          )}

          {activeTask.status === "cancelled" && (
            <p className="muted small">This analysis was cancelled.</p>
          )}

          {activeTask.status === "incomplete" && (
            <div className="advisor-callout" style={{ marginBottom: 12 }}>
              This analysis paused early (
              {activeTask.incomplete_reason ?? "step/time limit"}). Partial
              findings are shown below; send a follow-up to continue.
            </div>
          )}

          {activeTask.answer &&
            activeTask.status !== "failed" &&
            activeTask.status !== "cancelled" &&
            renderAdvisorMarkdown(activeTask.answer)}

          {activeTask.files.length > 0 && api && (
            <div className="advisor-files">
              <h3>Supporting analysis documents</h3>
              {activeTask.files.map((file, idx) => (
                <div className="advisor-file-row" key={file.path}>
                  <span>
                    <FileText size={15} />{" "}
                    <strong>Financial Schedule #{idx + 1}</strong>{" "}
                    <span className="small muted">
                      {file.bytes !== null ? `(${file.bytes} bytes)` : ""}
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
                title="Sandboxed financial analysis preview"
              />
            </div>
          )}

          {activeTask.can_continue && !demo && (
            <form
              className="advisor-followup-form"
              onSubmit={(e) => void submitFollowUp(e)}
            >
              <label htmlFor={followUpFieldId} className="sr-only">
                Follow up on this financial analysis
              </label>
              <input
                id={followUpFieldId}
                type="text"
                placeholder="Ask a follow-up or adjust an assumption on this analysis…"
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
                Continue analysis
              </button>
            </form>
          )}
        </section>
      )}

      {!demo && tasks.length > 0 && (
        <section className="panel">
          <div className="card-heading">
            <h2>Your saved advisor comparisons</h2>
            {api && (
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  void api
                    .listAgentTasks("advisor")
                    .then((list) => setTasks(list))
                }
              >
                <RefreshCw size={14} />
                Refresh
              </button>
            )}
          </div>
          <div className="advisor-history-list">
            {tasks.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`advisor-history-item ${
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
                  <strong>{summarizeQueryTitle(item.query)}</strong>
                  <span className="small muted" style={{ display: "block" }}>
                    {new Date(item.created_at).toLocaleString()}
                    {item.parent_task_id ? " · Follow-up" : ""}
                  </span>
                </span>
                <span className="pill neutral-pill">{item.status}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
