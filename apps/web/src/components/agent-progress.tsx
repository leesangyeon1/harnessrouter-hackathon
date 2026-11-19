"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Cpu, LoaderCircle, Sparkles } from "lucide-react";
import "./agent-progress.css";

type StageSpec = {
  title: string;
  detail: string;
};

const ADVISOR_STAGES: StageSpec[] = [
  {
    title: "Authorize & Verify",
    detail: "Validating balances, APRs & calculator inputs",
  },
  {
    title: "Scan Cards & Loans",
    detail: "Auditing promo windows, transfer & refi fees",
  },
  {
    title: "Cash Flow & Spend",
    detail: "Checking monthly budget & subscription relief",
  },
  {
    title: "Model Tradeoffs",
    detail: "Monthly payment relief vs. total lifetime cost",
  },
  {
    title: "Compile Report",
    detail: "Formatting 5-section comparison & next steps",
  },
];

const QUANT_STAGES: StageSpec[] = [
  {
    title: "Verify SHA-256",
    detail: "Checking pinned bars_hash, policy & costs",
  },
  {
    title: "Boot CPU Sandbox",
    detail: "Loading verbatim finance_core/quant.py",
  },
  {
    title: "Run Daily-v1",
    detail: "Backtesting M01–M08, M10, M11 & M00 baseline",
  },
  {
    title: "60-Bar Gate",
    detail: "Filtering ≤20% Stable DD & >0% confirmation",
  },
  {
    title: "Seal Report",
    detail: "Emitting SIMULATED winners & session files",
  },
];

function computeProgressPct(
  elapsedSec: number,
  eventCount: number,
  streamChars: number,
): number {
  // Smooth asymptotic time curve (reaches ~82% around 32s) + boosts from real SSE events & streamed tokens
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
  streamDelta,
  eventCount,
  onCancel,
}: {
  variant: "advisor" | "quant";
  activityLabel: string;
  queryTitle: string;
  streamDelta: string;
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
  const pct = computeProgressPct(elapsedSec, eventCount, streamDelta.length);
  const stages = variant === "advisor" ? ADVISOR_STAGES : QUANT_STAGES;
  const activeStage = resolveStageIndex(pct, streamDelta.length);
  const HeaderIcon = variant === "advisor" ? Sparkles : Cpu;

  return (
    <section
      className="agent-progress-card"
      role="status"
      aria-live="polite"
      aria-label={
        variant === "advisor"
          ? "Personal Finance Advisor report progress"
          : "CPU Quant Emulator evaluation progress"
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
                ? "HARNESSROUTER ADVISOR · LIVE REPORT GENERATION"
                : "ISOLATED CPU SANDBOX · LIVE STRATEGY BACKTEST"}
            </span>
            <p className="agent-progress-status-text">{activityLabel}</p>
          </div>
        </div>

        <div className="agent-progress-meta-right">
          <span className="agent-progress-telemetry">
            <LoaderCircle size={13} className="spin" />
            {elapsedSec.toFixed(1)}s elapsed · Stage {activeStage + 1}/
            {stages.length}
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
            ? "Advisor report completion percentage"
            : "Quant emulator completion percentage"
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
          {variant === "advisor" ? "Analyzing scenario:" : "Evaluating bundle:"}{" "}
          <strong>{queryTitle}</strong>
        </span>
        {streamDelta.length > 0 && (
          <span className="small muted">
            Streaming live output ({streamDelta.length.toLocaleString()} chars)
          </span>
        )}
      </div>

      {streamDelta && (
        <div className="agent-live-stream-wrap">
          <div className="agent-live-stream-bar">
            <span>
              <i className="agent-live-dot" />
              {variant === "advisor"
                ? "Live Markdown report stream"
                : "Live isolated CPU execution output"}
            </span>
            <span>deepseek-v4-pro · Hermes</span>
          </div>
          <pre className="agent-live-stream-pre">
            {streamDelta}
            <span className="agent-stream-cursor" aria-hidden="true" />
          </pre>
        </div>
      )}
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
