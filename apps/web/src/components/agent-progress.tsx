"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, LoaderCircle, Sparkles, TrendingUp } from "lucide-react";
import "./agent-progress.css";

type StageSpec = {
  title: string;
  detail: string;
  headline: string;
};

const ADVISOR_STAGES: StageSpec[] = [
  {
    title: "Retrieving Information",
    detail: "Gathering balances, APR terms, and account obligations",
    headline: "Retrieving financial profile, balances, and rate terms…",
  },
  {
    title: "Processing Data",
    detail: "Normalizing payment schedules, promo windows, and fees",
    headline: "Processing payment schedules, promotional periods, and fees…",
  },
  {
    title: "Analyzing Credits",
    detail: "Evaluating card utilization, loan rates, and refinancing",
    headline: "Analyzing credit cards, loan terms, and refinancing options…",
  },
  {
    title: "Modeling Cash Flow",
    detail: "Comparing monthly payment relief vs. lifetime interest",
    headline: "Comparing monthly cash-flow relief against total lifetime cost…",
  },
  {
    title: "Preparing Report",
    detail: "Building structured comparison table and action plan",
    headline: "Finalizing personalized financial comparison report…",
  },
];

const QUANT_STAGES: StageSpec[] = [
  {
    title: "Retrieving Market Data",
    detail: "Loading historical asset pricing, volume, and sessions",
    headline: "Retrieving historical market data and benchmark pricing…",
  },
  {
    title: "Processing Data",
    detail: "Normalizing daily return series and transaction costs",
    headline: "Processing asset return series and sector trading costs…",
  },
  {
    title: "Evaluating Strategies",
    detail: "Simulating trend, momentum, and mean-reversion models",
    headline: "Evaluating quantitative strategies against market benchmark…",
  },
  {
    title: "Analyzing Risk",
    detail: "Measuring Sharpe ratios, volatility, and drawdown limits",
    headline: "Analyzing risk-adjusted returns and maximum drawdown bounds…",
  },
  {
    title: "Preparing Report",
    detail: "Confirming out-of-sample performance and rankings",
    headline: "Finalizing Stable and Aggressive portfolio rankings…",
  },
];

const SECTOR_LABELS: Record<string, string> = {
  stock: "US Equities",
  bond: "Fixed-Income Bond ETFs",
  crypto: "Digital Asset USD Pairs",
};

export function formatFinancialScopeTitle(
  variant: "advisor" | "quant",
  rawQuery: string,
): string {
  const trimmed = rawQuery.trim();
  if (variant === "quant") {
    const symMatch = /symbol=([A-Z0-9/.-]+)\s*(?:\(([a-z_]+)\))?/i.exec(
      trimmed,
    );
    if (symMatch) {
      const sym = symMatch[1].toUpperCase();
      const secKey = (symMatch[2] ?? "").toLowerCase();
      const secName = SECTOR_LABELS[secKey] ?? "Multi-Asset";
      return `${sym} (${secName}) · Multi-Factor Risk & Return Simulation`;
    }
    if (
      /finance_core|\.py|```|bars_hash|policy_hash|synthetic/i.test(trimmed) ||
      !trimmed
    ) {
      return "Multi-Factor Quantitative Portfolio Simulation";
    }
    return trimmed.slice(0, 110);
  }

  // Advisor clean financial scope
  const firstCleanLine = trimmed
    .split("\n")
    .map((line) => line.replace(/^[#>*\-\s`]+/, "").trim())
    .find(
      (line) =>
        line.length > 0 &&
        !/^authorized|^verified_calculator|\.py|```/i.test(line),
    );
  if (!firstCleanLine) {
    return "Credit Card Payoff, Balance Transfer & Refinancing Evaluation";
  }
  return firstCleanLine.length > 105
    ? `${firstCleanLine.slice(0, 102)}…`
    : firstCleanLine;
}

function isTechnicalLabel(label: string): boolean {
  return /file|bash|python|shell|code|sandbox|cpu|hash|json|verbatim|exec|container|isolated/i.test(
    label,
  );
}

function computeProgressPct(
  elapsedSec: number,
  eventCount: number,
  streamChars: number,
): number {
  const timeComponent = 82 * (1 - Math.exp(-elapsedSec / 14));
  const eventBoost = Math.min(8, eventCount * 1.6);
  const streamBoost =
    streamChars > 0 ? Math.min(14, 4 + Math.log1p(streamChars) * 1.45) : 0;
  const raw = Math.max(8, timeComponent + eventBoost + streamBoost);
  return Math.min(96, Math.round(raw));
}

function resolveStageIndex(pct: number, streamChars: number): number {
  if (streamChars > 180 || pct >= 82) return 4;
  if (streamChars > 20 || pct >= 62) return 3;
  if (pct >= 40) return 2;
  if (pct >= 20) return 1;
  return 0;
}

export function AgentRunProgress({
  variant,
  activityLabel,
  queryTitle,
  streamChars,
  eventCount,
  onCancel,
}: {
  variant: "advisor" | "quant";
  activityLabel?: string;
  queryTitle: string;
  streamChars: number;
  eventCount: number;
  onCancel: () => void;
}) {
  const [ticks, setTicks] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTicks((prev) => prev + 1);
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

  const elapsedSec = ticks * 0.25;
  const pct = computeProgressPct(elapsedSec, eventCount, streamChars);
  const stages = variant === "advisor" ? ADVISOR_STAGES : QUANT_STAGES;
  const activeStage = resolveStageIndex(pct, streamChars);
  const HeaderIcon = variant === "advisor" ? Sparkles : TrendingUp;

  const cleanHeadline =
    activityLabel &&
    activityLabel.trim().length > 0 &&
    !isTechnicalLabel(activityLabel) &&
    !/^starting|^connecting/i.test(activityLabel)
      ? activityLabel
      : stages[activeStage].headline;

  const scopeLabel = formatFinancialScopeTitle(variant, queryTitle);

  return (
    <section
      className="agent-progress-card"
      role="status"
      aria-live="polite"
      aria-label={
        variant === "advisor"
          ? "Personal Finance Advisor analysis progress"
          : "Quantitative strategy evaluation progress"
      }
    >
      <div className="agent-progress-header">
        <div className="agent-progress-title-wrap">
          <span className="agent-pulse-orb" aria-hidden="true">
            <HeaderIcon size={18} />
          </span>
          <div>
            <span className="agent-progress-eyebrow">
              {variant === "advisor"
                ? "PERSONAL FINANCE ADVISOR · CREDIT & CASH-FLOW ANALYSIS"
                : "QUANTITATIVE PORTFOLIO ENGINE · STRATEGY EVALUATION"}
            </span>
            <p className="agent-progress-status-text">{cleanHeadline}</p>
          </div>
        </div>

        <div className="agent-progress-meta-right">
          <span className="agent-progress-telemetry">
            <LoaderCircle size={13} className="spin" />
            Step {activeStage + 1} of {stages.length} · {elapsedSec.toFixed(1)}s
          </span>
          <span className="agent-progress-pct">{pct}%</span>
          <button type="button" className="button secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>

      <div
        className="agent-bar-track"
        role="progressbar"
        aria-label={
          variant === "advisor"
            ? "Financial analysis completion percentage"
            : "Quantitative strategy evaluation completion percentage"
        }
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className="agent-bar-fill" style={{ width: `${pct}%` }} />
      </div>

      <div className="agent-stages-grid">
        {stages.map((stage, idx) => {
          const isDone = idx < activeStage;
          const isCurrent = idx === activeStage;
          return (
            <div
              key={stage.title}
              className={`agent-stage-step ${
                isDone ? "done" : isCurrent ? "active" : ""
              }`}
            >
              <div className="agent-stage-top">
                {isDone ? (
                  <CheckCircle2 size={15} />
                ) : isCurrent ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <span className="agent-stage-index">{idx + 1}</span>
                )}
                <span>{stage.title}</span>
              </div>
              <span className="agent-stage-desc">{stage.detail}</span>
            </div>
          );
        })}
      </div>

      <div className="agent-query-caption">
        <span>
          {variant === "advisor" ? "Analysis scope:" : "Evaluation scope:"}{" "}
          <strong>{scopeLabel}</strong>
        </span>
        <span className="agent-live-pill">
          <i className="agent-live-dot" aria-hidden="true" />
          {streamChars > 0
            ? variant === "advisor"
              ? "Compiling verified financial figures"
              : "Computing portfolio risk & return metrics"
            : variant === "advisor"
              ? "Reviewing rates, balances & schedules"
              : "Evaluating historical market series"}
        </span>
      </div>
    </section>
  );
}

export function ReportCompletedBar({
  label,
  pills,
}: {
  label: string;
  pills: string[];
}) {
  return (
    <div className="report-complete-banner">
      <div className="report-complete-row">
        <span>
          <CheckCircle2
            size={14}
            style={{ verticalAlign: "-2px", marginRight: 6 }}
          />
          {label}
        </span>
        <span>100% Complete</span>
      </div>
      <div
        className="report-complete-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={100}
      >
        <div className="report-complete-fill" style={{ width: "100%" }} />
      </div>
      {pills.length > 0 && (
        <div className="report-section-pills">
          {pills.map((pill) => (
            <span key={pill} className="report-section-pill">
              <CheckCircle2 size={11} />
              {pill}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
