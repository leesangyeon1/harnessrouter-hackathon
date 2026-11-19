"use client";
import { Fragment, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Cpu,
  Download,
  FileSpreadsheet,
  Layers,
  Search,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import {
  QUANT_BENCHMARK_SUMMARY,
  QUANT_MODEL_LEADERBOARD,
  QUANT_PERFORMANCE_CASES,
  type QuantPerformanceCase,
} from "@/lib/quant-cases-data";

function fmtUsd(value: number, signed = false): string {
  const abs = Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (value < 0) return `-$${abs}`;
  if (signed && value > 0) return `+$${abs}`;
  return `$${abs}`;
}

function fmtSignedPct(value: number): string {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)}%`;
}

function csvCell(value: string | number): string {
  const raw = String(value);
  if (raw.includes(",") || raw.includes('"') || raw.includes("\n")) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

export function QuantCasesPanel() {
  const [selectedCaseId, setSelectedCaseId] = useState<string>(
    QUANT_PERFORMANCE_CASES[0].caseId,
  );
  const [expandedCaseIds, setExpandedCaseIds] = useState<Record<string, boolean>>(
    () => ({ [QUANT_PERFORMANCE_CASES[0].caseId]: true }),
  );
  const [outcomeFilter, setOutcomeFilter] = useState<"ALL" | "PROFIT" | "LOSS">(
    "ALL",
  );
  const [modeFilter, setModeFilter] = useState<"ALL" | "Stable" | "Aggressive">(
    "ALL",
  );
  const [searchQuery, setSearchQuery] = useState<string>("");

  const [legSectorFilter, setLegSectorFilter] = useState<
    "ALL" | "stock" | "bond" | "crypto"
  >("ALL");
  const [legFamilyFilter, setLegFamilyFilter] = useState<string>("ALL");
  const [legOutcomeFilter, setLegOutcomeFilter] = useState<
    "ALL" | "WIN" | "LOSS"
  >("ALL");
  const [legSortOrder, setLegSortOrder] = useState<
    "INDEX" | "PNL_DESC" | "PNL_ASC"
  >("PNL_DESC");

  const inspectorRef = useRef<HTMLElement | null>(null);

  const filteredCases = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return QUANT_PERFORMANCE_CASES.filter((item) => {
      if (outcomeFilter !== "ALL" && item.outcome !== outcomeFilter) {
        return false;
      }
      if (modeFilter !== "ALL" && item.mode !== modeFilter) {
        return false;
      }
      if (!q) return true;
      if (
        item.caseId.toLowerCase().includes(q) ||
        item.cycleDate.toLowerCase().includes(q) ||
        item.regimeNote.toLowerCase().includes(q) ||
        item.workerCluster.toLowerCase().includes(q) ||
        item.quantsUsedSummary.toLowerCase().includes(q)
      ) {
        return true;
      }
      return item.legs.some(
        (leg) =>
          leg.ticker.toLowerCase().includes(q) ||
          leg.assetName.toLowerCase().includes(q) ||
          leg.quantId.toLowerCase().includes(q) ||
          leg.quantName.toLowerCase().includes(q) ||
          leg.family.toLowerCase().includes(q) ||
          leg.algorithmFormula.toLowerCase().includes(q),
      );
    });
  }, [modeFilter, outcomeFilter, searchQuery]);

  const selectedCase: QuantPerformanceCase = useMemo(() => {
    return (
      QUANT_PERFORMANCE_CASES.find((c) => c.caseId === selectedCaseId) ??
      QUANT_PERFORMANCE_CASES[0]
    );
  }, [selectedCaseId]);

  const selectedIndex = useMemo(() => {
    const idx = QUANT_PERFORMANCE_CASES.findIndex(
      (c) => c.caseId === selectedCase.caseId,
    );
    return idx >= 0 ? idx : 0;
  }, [selectedCase]);

  const filteredLegs = useMemo(() => {
    const base = selectedCase.legs.filter((leg) => {
      if (legSectorFilter !== "ALL" && leg.sector !== legSectorFilter) {
        return false;
      }
      if (legFamilyFilter !== "ALL" && leg.family !== legFamilyFilter) {
        return false;
      }
      if (legOutcomeFilter !== "ALL" && leg.quantOutcome !== legOutcomeFilter) {
        return false;
      }
      return true;
    });
    if (legSortOrder === "PNL_DESC") {
      return [...base].sort(
        (a, b) => b.netPnlUsd - a.netPnlUsd || a.legIndex - b.legIndex,
      );
    }
    if (legSortOrder === "PNL_ASC") {
      return [...base].sort(
        (a, b) => a.netPnlUsd - b.netPnlUsd || a.legIndex - b.legIndex,
      );
    }
    return base;
  }, [
    legFamilyFilter,
    legOutcomeFilter,
    legSectorFilter,
    legSortOrder,
    selectedCase,
  ]);

  const maxAbsLegPnlInCase = useMemo(() => {
    return Math.max(
      1,
      ...selectedCase.legs.map((l) => Math.abs(l.netPnlUsd)),
    );
  }, [selectedCase]);

  const filteredLegsTotals = useMemo(() => {
    const notional = filteredLegs.reduce((acc, l) => acc + l.notionalUsd, 0);
    const grossPnl = filteredLegs.reduce((acc, l) => acc + l.grossPnlUsd, 0);
    const fees = filteredLegs.reduce((acc, l) => acc + l.feeUsd, 0);
    const netPnl = filteredLegs.reduce((acc, l) => acc + l.netPnlUsd, 0);
    return {
      notional: Number(notional.toFixed(2)),
      grossPnl: Number(grossPnl.toFixed(2)),
      fees: Number(fees.toFixed(2)),
      netPnl: Number(netPnl.toFixed(2)),
    };
  }, [filteredLegs]);

  function toggleInlineCase(caseId: string) {
    setSelectedCaseId(caseId);
    setExpandedCaseIds((prev) => ({
      ...prev,
      [caseId]: !prev[caseId],
    }));
  }

  function selectAndInspect(caseId: string) {
    setSelectedCaseId(caseId);
    requestAnimationFrame(() => {
      inspectorRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  }

  function exportCasesJson() {
    const payload = {
      exportedAtUtc: new Date().toISOString(),
      summary: QUANT_BENCHMARK_SUMMARY,
      quantLeaderboard: QUANT_MODEL_LEADERBOARD,
      cases: QUANT_PERFORMANCE_CASES,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "quant-performance-30-cases-70loss-30win.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function exportAllLegsCsv() {
    const headers = [
      "case_number",
      "case_id",
      "cycle_id",
      "cycle_date",
      "case_outcome",
      "mode",
      "policy_version",
      "model_set_version",
      "case_started_utc",
      "case_completed_utc",
      "case_compute_sec",
      "worker_cluster",
      "leg_index",
      "quant_rank_in_case",
      "quant_id",
      "quant_name",
      "family",
      "algorithm_formula",
      "parameters_summary",
      "quant_outcome",
      "ticker",
      "asset_name",
      "sector",
      "signal",
      "weight_pct",
      "entry_time_utc",
      "exit_time_utc",
      "entry_price",
      "exit_price",
      "quantity",
      "notional_usd",
      "bars_evaluated",
      "bar_hit_rate_pct",
      "compute_ms",
      "selection_sharpe",
      "realized_sortino",
      "max_drawdown_pct",
      "confirmation_return_pct",
      "gross_return_pct",
      "gross_pnl_usd",
      "fee_bps",
      "fee_usd",
      "net_pnl_usd",
      "net_return_pct",
    ];
    const rows = [headers.join(",")];
    for (const c of QUANT_PERFORMANCE_CASES) {
      for (const leg of c.legs) {
        rows.push(
          [
            c.caseNumber,
            c.caseId,
            c.cycleId,
            c.cycleDate,
            c.outcome,
            c.mode,
            c.policyVersion,
            c.modelSetVersion,
            c.startedAtUtc,
            c.completedAtUtc,
            c.totalComputeSec,
            c.workerCluster,
            leg.legIndex,
            leg.quantRankInCase,
            leg.quantId,
            leg.quantName,
            leg.family,
            leg.algorithmFormula,
            leg.parametersSummary,
            leg.quantOutcome,
            leg.ticker,
            leg.assetName,
            leg.sector,
            leg.signal,
            leg.weightPct,
            leg.entryTimeUtc,
            leg.exitTimeUtc,
            leg.entryPrice,
            leg.exitPrice,
            leg.quantity,
            leg.notionalUsd,
            leg.barsEvaluated,
            leg.barHitRatePct,
            leg.computeMs,
            leg.selectionSharpe,
            leg.realizedSortino,
            leg.maxDrawdownPct,
            leg.confirmationReturnPct,
            leg.grossReturnPct,
            leg.grossPnlUsd,
            leg.feeBps,
            leg.feeUsd,
            leg.netPnlUsd,
            leg.netReturnPct,
          ]
            .map(csvCell)
            .join(","),
        );
      }
    }
    const blob = new Blob([rows.join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "quant-performance-660-quant-runs.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="qcase-root">
      <div className="ops-stats perf-stats">
        <section>
          <span>Logged evaluation cases</span>
          <strong>{QUANT_BENCHMARK_SUMMARY.totalCases}</strong>
          <small>
            22 distinct quants &amp; 22 tickers per case ·{" "}
            {QUANT_BENCHMARK_SUMMARY.totalLegExecutions} individual quant runs
          </small>
        </section>
        <section>
          <span>Loss / winning case split</span>
          <strong>
            {QUANT_BENCHMARK_SUMMARY.lossCases}L /{" "}
            {QUANT_BENCHMARK_SUMMARY.profitCases}W
          </strong>
          <small>
            <strong className="perf-neg">
              {QUANT_BENCHMARK_SUMMARY.lossRatePct.toFixed(1)}% loss
            </strong>{" "}
            ({QUANT_BENCHMARK_SUMMARY.lossCases} cases) ·{" "}
            <strong className="perf-pos">
              {QUANT_BENCHMARK_SUMMARY.profitRatePct.toFixed(1)}% winning
            </strong>{" "}
            ({QUANT_BENCHMARK_SUMMARY.profitCases} cases)
          </small>
        </section>
        <section>
          <span>Cumulative net P&amp;L</span>
          <strong
            className={`small-stat ${
              QUANT_BENCHMARK_SUMMARY.totalNetPnlUsd >= 0
                ? "perf-pos"
                : "perf-neg"
            }`}
          >
            {fmtUsd(QUANT_BENCHMARK_SUMMARY.totalNetPnlUsd, true)}
          </strong>
          <small>
            Gross {fmtUsd(QUANT_BENCHMARK_SUMMARY.totalGrossPnlUsd, true)} minus{" "}
            {fmtUsd(QUANT_BENCHMARK_SUMMARY.totalFeesUsd)} fees ($100k/case)
          </small>
        </section>
        <section>
          <span>Per-quant execution split</span>
          <strong className="small-stat">
            {QUANT_BENCHMARK_SUMMARY.totalWinningQuantRuns}W /{" "}
            {QUANT_BENCHMARK_SUMMARY.totalLosingQuantRuns}L
          </strong>
          <small>
            {QUANT_BENCHMARK_SUMMARY.distinctQuantsCatalogCount} distinct models
            (<code>M01</code>–<code>M24</code>) · Mean Sharpe{" "}
            {QUANT_BENCHMARK_SUMMARY.meanSharpe.toFixed(2)}
          </small>
        </section>
      </div>

      <section className="ops-panel qcase-master-panel">
        <div className="panel-heading perf-filter-heading">
          <div>
            <h2>
              30-case multi-quant execution log ({filteredCases.length} of{" "}
              {QUANT_BENCHMARK_SUMMARY.totalCases} cases shown)
            </h2>
            <p>
              <strong>21 loss cases (70.0%)</strong> and{" "}
              <strong>9 winning cases (30.0%)</strong>. Click any case row (or{" "}
              <strong>Show 22 quants</strong>) to expand the exact 22 quant
              algorithms, mathematical formulas, tickers, and per-quant P&amp;L
              used in that case.
            </p>
          </div>
          <div className="perf-actions">
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                const allOpen = filteredCases.every(
                  (c) => expandedCaseIds[c.caseId],
                );
                if (allOpen) {
                  setExpandedCaseIds({});
                } else {
                  const next: Record<string, boolean> = {};
                  for (const c of filteredCases) {
                    next[c.caseId] = true;
                  }
                  setExpandedCaseIds(next);
                }
              }}
            >
              <Layers size={15} />
              {filteredCases.every((c) => expandedCaseIds[c.caseId])
                ? "Collapse inline quants"
                : "Expand all 30 cases' quants"}
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={exportAllLegsCsv}
            >
              <FileSpreadsheet size={15} />
              Export 660 quant runs CSV
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={exportCasesJson}
            >
              <Download size={15} />
              Export 30 cases JSON
            </button>
          </div>
        </div>

        <div className="qcase-filter-bar">
          <div
            className="qcase-outcome-pills"
            role="group"
            aria-label="Filter by case outcome"
          >
            <button
              type="button"
              className={`perf-tab ${outcomeFilter === "ALL" ? "active" : ""}`}
              onClick={() => setOutcomeFilter("ALL")}
            >
              All cases ({QUANT_BENCHMARK_SUMMARY.totalCases})
            </button>
            <button
              type="button"
              className={`perf-tab ${outcomeFilter === "LOSS" ? "active" : ""}`}
              onClick={() => setOutcomeFilter("LOSS")}
            >
              <TrendingDown size={14} />
              Loss cases ({QUANT_BENCHMARK_SUMMARY.lossCases} ·{" "}
              {QUANT_BENCHMARK_SUMMARY.lossRatePct.toFixed(0)}%)
            </button>
            <button
              type="button"
              className={`perf-tab ${outcomeFilter === "PROFIT" ? "active" : ""}`}
              onClick={() => setOutcomeFilter("PROFIT")}
            >
              <TrendingUp size={14} />
              Winning cases ({QUANT_BENCHMARK_SUMMARY.profitCases} ·{" "}
              {QUANT_BENCHMARK_SUMMARY.profitRatePct.toFixed(0)}%)
            </button>
          </div>

          <div className="perf-filters">
            <div className="qcase-search-wrap">
              <Search size={14} />
              <input
                type="search"
                aria-label="Search cases, tickers, or quant strategies"
                placeholder="Search case, ticker (NVDA, BTC/USD), quant (M01, Kalman, RSI)…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <select
              aria-label="Filter cases by mode"
              value={modeFilter}
              onChange={(e) =>
                setModeFilter(e.target.value as "ALL" | "Stable" | "Aggressive")
              }
            >
              <option value="ALL">All policy modes</option>
              <option value="Stable">Stable mode (v1)</option>
              <option value="Aggressive">Aggressive mode (v2)</option>
            </select>
          </div>
        </div>

        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label="30-case quant performance log table"
        >
          <table className="qcase-table">
            <thead>
              <tr>
                <th>Case ID &amp; Date</th>
                <th>Outcome</th>
                <th>Mode &amp; Window (UTC)</th>
                <th>Quants Used (22 Models)</th>
                <th>Best &amp; Worst Quant in Case</th>
                <th>Start → End Capital</th>
                <th>Net P&amp;L ($ / %)</th>
                <th>Sharpe / Sortino / DD</th>
                <th>Regime &amp; Per-Quant Breakdown</th>
              </tr>
            </thead>
            <tbody>
              {filteredCases.map((c) => {
                const isSelected = c.caseId === selectedCase.caseId;
                const isExpanded = Boolean(expandedCaseIds[c.caseId]);
                return (
                  <Fragment key={c.caseId}>
                    <tr
                      className={`qcase-row ${isSelected ? "selected" : ""}`}
                      onClick={() => toggleInlineCase(c.caseId)}
                    >
                      <td>
                        <div className="qcase-cell-stack">
                          <strong>
                            <code>{c.caseId}</code>
                          </strong>
                          <span className="perf-dim">
                            Case #{c.caseNumber} · {c.cycleDate}
                          </span>
                        </div>
                      </td>
                      <td>
                        <span
                          className={`perf-badge ${
                            c.outcome === "PROFIT" ? "win" : "err"
                          }`}
                        >
                          {c.outcome === "PROFIT" ? (
                            <TrendingUp size={11} />
                          ) : (
                            <TrendingDown size={11} />
                          )}
                          {c.outcome === "PROFIT" ? "WINNING" : "LOSS"}
                        </span>
                      </td>
                      <td>
                        <div className="qcase-cell-stack">
                          <span>
                            <span
                              className={`perf-badge ${
                                c.mode === "Aggressive" ? "aggr" : "neutral"
                              }`}
                            >
                              {c.mode} v{c.policyVersion}
                            </span>{" "}
                            <span className="perf-dim">
                              {c.totalComputeSec.toFixed(1)}s
                            </span>
                          </span>
                          <span className="perf-dim">
                            {c.startedAtUtc.slice(11, 19)} →{" "}
                            {c.completedAtUtc.slice(11, 19)} UTC
                          </span>
                        </div>
                      </td>
                      <td>
                        <div className="qcase-cell-stack">
                          <strong>
                            <code>{c.quantsUsedSummary}</code>
                          </strong>
                          <span>
                            <span className="perf-pos">
                              {c.winningLegsCount}W
                            </span>{" "}
                            /{" "}
                            <span className="perf-neg">
                              {c.losingLegsCount}L
                            </span>{" "}
                            <span className="perf-dim">
                              ({c.legWinRatePct.toFixed(1)}% quant win rate)
                            </span>
                          </span>
                        </div>
                      </td>
                      <td>
                        <div className="qcase-cell-stack">
                          <span>
                            <span className="perf-badge win">Best</span>{" "}
                            <code>{c.bestQuantId}</code> {c.bestQuantName} (
                            <strong>{c.bestQuantTicker}</strong>){" "}
                            <span className="perf-pos">
                              {fmtUsd(c.bestQuantNetPnlUsd, true)} (
                              {fmtSignedPct(c.bestQuantNetReturnPct)})
                            </span>
                          </span>
                          <span>
                            <span className="perf-badge err">Worst</span>{" "}
                            <code>{c.worstQuantId}</code> {c.worstQuantName} (
                            <strong>{c.worstQuantTicker}</strong>){" "}
                            <span className="perf-neg">
                              {fmtUsd(c.worstQuantNetPnlUsd, true)} (
                              {fmtSignedPct(c.worstQuantNetReturnPct)})
                            </span>
                          </span>
                        </div>
                      </td>
                      <td>
                        <div className="qcase-cell-stack">
                          <span>
                            {fmtUsd(c.startingCapitalUsd)} →{" "}
                            <strong>{fmtUsd(c.endingCapitalUsd)}</strong>
                          </span>
                          <span className="perf-dim">
                            Deployed {fmtUsd(c.deployedCapitalUsd)} · Fees{" "}
                            {fmtUsd(c.totalFeesUsd)}
                          </span>
                        </div>
                      </td>
                      <td>
                        <div className="qcase-cell-stack">
                          <span
                            className={
                              c.netPnlUsd >= 0 ? "perf-pos" : "perf-neg"
                            }
                          >
                            {fmtUsd(c.netPnlUsd, true)}
                          </span>
                          <span
                            className={
                              c.netReturnPct >= 0 ? "perf-pos" : "perf-neg"
                            }
                          >
                            {fmtSignedPct(c.netReturnPct)}
                          </span>
                        </div>
                      </td>
                      <td>
                        <div className="qcase-cell-stack">
                          <span>
                            SR <strong>{c.portfolioSharpe.toFixed(2)}</strong> ·
                            Sortino {c.sortinoRatio.toFixed(2)}
                          </span>
                          <span className="perf-dim">
                            Max DD {c.maxDrawdownPct.toFixed(2)}%
                          </span>
                        </div>
                      </td>
                      <td>
                        <div className="qcase-regime-cell">
                          <span
                            className="qcase-regime-note"
                            title={c.regimeNote}
                          >
                            {c.regimeNote}
                          </span>
                          <div className="qcase-row-btns">
                            <button
                              type="button"
                              className={`qcase-inspect-btn ${
                                isExpanded ? "active" : ""
                              }`}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleInlineCase(c.caseId);
                              }}
                            >
                              {isExpanded ? (
                                <>
                                  <ChevronUp size={12} /> Hide 22 quants
                                </>
                              ) : (
                                <>
                                  <ChevronDown size={12} /> Show 22 quants
                                </>
                              )}
                            </button>
                            <button
                              type="button"
                              className="qcase-inspect-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                selectAndInspect(c.caseId);
                              }}
                            >
                              <ArrowDown size={11} /> Full view
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="qcase-inline-drawer-row">
                        <td colSpan={9}>
                          <div className="qcase-inline-drawer">
                            <div className="qcase-inline-drawer-head">
                              <div>
                                <strong>
                                  {c.caseId} ({c.cycleDate}) — Exact 22 Quants
                                  Used &amp; Per-Quant Performance
                                </strong>
                                <span className="perf-dim">
                                  Worker <code>{c.workerCluster}</code> · Gross{" "}
                                  {fmtUsd(c.totalGrossPnlUsd, true)} − Fees{" "}
                                  {fmtUsd(c.totalFeesUsd)} = Net{" "}
                                  <strong
                                    className={
                                      c.netPnlUsd >= 0 ? "perf-pos" : "perf-neg"
                                    }
                                  >
                                    {fmtUsd(c.netPnlUsd, true)} (
                                    {fmtSignedPct(c.netReturnPct)})
                                  </strong>
                                </span>
                              </div>
                              <button
                                type="button"
                                className="qcase-inspect-btn active"
                                onClick={() => selectAndInspect(c.caseId)}
                              >
                                <ArrowDown size={12} /> Open in deep inspector
                              </button>
                            </div>
                            <div className="table-scroll">
                              <table className="qcase-inline-table">
                                <thead>
                                  <tr>
                                    <th>Rank</th>
                                    <th>Quant ID &amp; Strategy Name</th>
                                    <th>Family</th>
                                    <th>Exact Formula &amp; Parameters Used</th>
                                    <th>Ticker &amp; Sector</th>
                                    <th>Signal &amp; Capital</th>
                                    <th>Entry → Exit Price &amp; Time (UTC)</th>
                                    <th>Gross P&amp;L</th>
                                    <th>Fee</th>
                                    <th>Quant Net P&amp;L</th>
                                    <th>Quant Return</th>
                                    <th>Sharpe / Sortino / DD / Hit%</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {[...c.legs]
                                    .sort(
                                      (a, b) =>
                                        a.quantRankInCase - b.quantRankInCase,
                                    )
                                    .map((leg) => (
                                      <tr
                                        key={`${c.caseId}-inline-${leg.legIndex}`}
                                      >
                                        <td>
                                          <code>#{leg.quantRankInCase}</code>
                                        </td>
                                        <td>
                                          <div className="qcase-cell-stack">
                                            <span>
                                              <code>{leg.quantId}</code>{" "}
                                              <strong>{leg.quantName}</strong>
                                            </span>
                                            <span
                                              className={`perf-badge ${
                                                leg.quantOutcome === "WIN"
                                                  ? "win"
                                                  : "err"
                                              }`}
                                            >
                                              {leg.quantOutcome} (Leg #
                                              {String(leg.legIndex).padStart(
                                                2,
                                                "0",
                                              )}
                                              )
                                            </span>
                                          </div>
                                        </td>
                                        <td>
                                          <span className="perf-badge neutral">
                                            {leg.family}
                                          </span>
                                        </td>
                                        <td>
                                          <div className="qcase-cell-stack">
                                            <code className="qcase-formula">
                                              {leg.algorithmFormula}
                                            </code>
                                            <span className="perf-dim">
                                              {leg.parametersSummary}
                                            </span>
                                          </div>
                                        </td>
                                        <td>
                                          <div className="qcase-cell-stack">
                                            <span>
                                              <strong>{leg.ticker}</strong>{" "}
                                              <span className="perf-badge neutral">
                                                {leg.sector}
                                              </span>
                                            </span>
                                            <span className="perf-dim">
                                              {leg.assetName}
                                            </span>
                                          </div>
                                        </td>
                                        <td>
                                          <div className="qcase-cell-stack">
                                            <code>{leg.signal}</code>
                                            <span className="perf-dim">
                                              {fmtUsd(leg.notionalUsd)} (
                                              {leg.weightPct.toFixed(2)}%)
                                            </span>
                                          </div>
                                        </td>
                                        <td>
                                          <div className="qcase-cell-stack">
                                            <span>
                                              {fmtUsd(leg.entryPrice)} →{" "}
                                              <strong>
                                                {fmtUsd(leg.exitPrice)}
                                              </strong>
                                            </span>
                                            <span className="perf-dim">
                                              {leg.entryTimeUtc.slice(11, 19)} →{" "}
                                              {leg.exitTimeUtc.slice(11, 19)}{" "}
                                              UTC
                                            </span>
                                          </div>
                                        </td>
                                        <td>
                                          <span
                                            className={
                                              leg.grossPnlUsd >= 0
                                                ? "perf-pos"
                                                : "perf-neg"
                                            }
                                          >
                                            {fmtUsd(leg.grossPnlUsd, true)} (
                                            {fmtSignedPct(leg.grossReturnPct)})
                                          </span>
                                        </td>
                                        <td>
                                          {fmtUsd(leg.feeUsd)} (
                                          {leg.feeBps.toFixed(0)} bps)
                                        </td>
                                        <td>
                                          <strong
                                            className={
                                              leg.netPnlUsd >= 0
                                                ? "perf-pos"
                                                : "perf-neg"
                                            }
                                          >
                                            {fmtUsd(leg.netPnlUsd, true)}
                                          </strong>
                                        </td>
                                        <td>
                                          <strong
                                            className={
                                              leg.netReturnPct >= 0
                                                ? "perf-pos"
                                                : "perf-neg"
                                            }
                                          >
                                            {fmtSignedPct(leg.netReturnPct)}
                                          </strong>
                                        </td>
                                        <td>
                                          <div className="qcase-cell-stack">
                                            <span>
                                              SR{" "}
                                              <strong>
                                                {leg.selectionSharpe.toFixed(2)}
                                              </strong>{" "}
                                              · Sortino{" "}
                                              {leg.realizedSortino.toFixed(2)}
                                            </span>
                                            <span className="perf-dim">
                                              DD {leg.maxDrawdownPct.toFixed(1)}
                                              % · Hit{" "}
                                              {leg.barHitRatePct.toFixed(1)}% (
                                              {leg.barsEvaluated}b)
                                            </span>
                                          </div>
                                        </td>
                                      </tr>
                                    ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section
        id="case-detail-inspector"
        ref={inspectorRef}
        className="ops-panel qcase-inspector"
      >
        <div className="panel-heading perf-filter-heading">
          <div>
            <div className="qcase-inspector-title">
              <h2>
                Case #{selectedCase.caseNumber} ·{" "}
                <code>{selectedCase.caseId}</code> — Precise Per-Quant
                Attribution (22 Quants)
              </h2>
              <span
                className={`perf-badge ${
                  selectedCase.outcome === "PROFIT" ? "win" : "err"
                }`}
              >
                {selectedCase.outcome === "PROFIT" ? "WINNING" : "LOSS"} ·{" "}
                {fmtUsd(selectedCase.netPnlUsd, true)} (
                {fmtSignedPct(selectedCase.netReturnPct)})
              </span>
              <span
                className={`perf-badge ${
                  selectedCase.mode === "Aggressive" ? "aggr" : "neutral"
                }`}
              >
                {selectedCase.mode} · Policy v{selectedCase.policyVersion}
              </span>
            </div>
            <p>{selectedCase.regimeNote}</p>
          </div>

          <div className="qcase-stepper">
            <button
              type="button"
              className="button secondary"
              disabled={selectedIndex <= 0}
              onClick={() =>
                setSelectedCaseId(
                  QUANT_PERFORMANCE_CASES[Math.max(0, selectedIndex - 1)]
                    .caseId,
                )
              }
            >
              <ChevronLeft size={15} />
              Prev
            </button>
            <select
              aria-label="Select case to inspect all 22 quant legs"
              value={selectedCase.caseId}
              onChange={(e) => setSelectedCaseId(e.target.value)}
            >
              {QUANT_PERFORMANCE_CASES.map((item) => (
                <option key={item.caseId} value={item.caseId}>
                  {item.caseId} ({item.cycleDate}) ·{" "}
                  {item.outcome === "PROFIT" ? "WIN" : "LOSS"}{" "}
                  {fmtUsd(item.netPnlUsd, true)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="button secondary"
              disabled={selectedIndex >= QUANT_PERFORMANCE_CASES.length - 1}
              onClick={() =>
                setSelectedCaseId(
                  QUANT_PERFORMANCE_CASES[
                    Math.min(
                      QUANT_PERFORMANCE_CASES.length - 1,
                      selectedIndex + 1,
                    )
                  ].caseId,
                )
              }
            >
              Next
              <ChevronRight size={15} />
            </button>
          </div>
        </div>

        <div className="qcase-meta-strip">
          <div>
            <span className="perf-gov-label">
              <Clock size={11} /> Execution timestamps (UTC)
            </span>
            <span>
              {selectedCase.startedAtUtc} → {selectedCase.completedAtUtc} (
              {selectedCase.totalComputeSec.toFixed(2)}s)
            </span>
          </div>
          <div>
            <span className="perf-gov-label">
              <Cpu size={11} /> Quants deployed &amp; node
            </span>
            <span>
              <code>{selectedCase.quantsUsedSummary}</code> ·{" "}
              <strong className="perf-pos">
                {selectedCase.winningLegsCount}W
              </strong>{" "}
              /{" "}
              <strong className="perf-neg">
                {selectedCase.losingLegsCount}L
              </strong>{" "}
              on <code>{selectedCase.workerCluster}</code>
            </span>
          </div>
          <div>
            <span className="perf-gov-label">
              <Layers size={11} /> Capital &amp; P&amp;L reconciliation
            </span>
            <span>
              Start {fmtUsd(selectedCase.startingCapitalUsd)} · Gross{" "}
              {fmtUsd(selectedCase.totalGrossPnlUsd, true)} − Fees{" "}
              {fmtUsd(selectedCase.totalFeesUsd)} ={" "}
              <strong
                className={
                  selectedCase.netPnlUsd >= 0 ? "perf-pos" : "perf-neg"
                }
              >
                {fmtUsd(selectedCase.netPnlUsd, true)}
              </strong>
            </span>
          </div>
          <div>
            <span className="perf-gov-label">Pinned SHA-256 governance</span>
            <span>
              bars <code>{selectedCase.barsHashPrefix}</code> · policy{" "}
              <code>{selectedCase.policyHashPrefix.slice(0, 10)}</code> · costs{" "}
              <code>{selectedCase.costsHashPrefix.slice(0, 10)}</code>
            </span>
          </div>
        </div>

        <div className="qcase-filter-bar qcase-leg-filter-bar">
          <div className="perf-filters">
            <select
              aria-label="Sort quants inside selected case"
              value={legSortOrder}
              onChange={(e) =>
                setLegSortOrder(
                  e.target.value as "INDEX" | "PNL_DESC" | "PNL_ASC",
                )
              }
            >
              <option value="PNL_DESC">
                Sort: Best → Worst Quant Performance
              </option>
              <option value="PNL_ASC">
                Sort: Worst → Best Quant Performance
              </option>
              <option value="INDEX">Sort: Execution Leg #01 → #22</option>
            </select>
            <select
              aria-label="Filter legs by asset sector"
              value={legSectorFilter}
              onChange={(e) =>
                setLegSectorFilter(
                  e.target.value as "ALL" | "stock" | "bond" | "crypto",
                )
              }
            >
              <option value="ALL">All sectors (22 quants)</option>
              <option value="stock">Equities / Stocks</option>
              <option value="bond">Treasury &amp; Credit Bond ETFs</option>
              <option value="crypto">Crypto USD Pairs</option>
            </select>
            <select
              aria-label="Filter legs by quant strategy family"
              value={legFamilyFilter}
              onChange={(e) => setLegFamilyFilter(e.target.value)}
            >
              <option value="ALL">All quant families</option>
              <option value="Trend">Trend</option>
              <option value="Momentum">Momentum</option>
              <option value="Mean Reversion">Mean Reversion</option>
              <option value="Breakout">Breakout</option>
              <option value="Statistical">Statistical</option>
              <option value="Regime">Regime</option>
            </select>
            <select
              aria-label="Filter legs by quant outcome"
              value={legOutcomeFilter}
              onChange={(e) =>
                setLegOutcomeFilter(e.target.value as "ALL" | "WIN" | "LOSS")
              }
            >
              <option value="ALL">All quant outcomes</option>
              <option value="WIN">Winning quants only</option>
              <option value="LOSS">Losing quants only</option>
            </select>
          </div>
          <span className="perf-dim qcase-leg-count">
            Showing {filteredLegs.length} of {selectedCase.totalLegsCount}{" "}
            quants used in {selectedCase.caseId}
          </span>
        </div>

        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label={`All 22 quant models and performance for ${selectedCase.caseId}`}
        >
          <table className="qcase-legs-table">
            <thead>
              <tr>
                <th>Rank / Leg</th>
                <th>Quant Strategy Used</th>
                <th>Exact Mathematical Formula &amp; Parameters</th>
                <th>Ticker &amp; Asset</th>
                <th>Signal &amp; Allocation</th>
                <th>Entry → Exit Time (UTC)</th>
                <th>Entry → Exit Price</th>
                <th>Bars, Hit% &amp; Latency</th>
                <th>Sharpe / Sortino / DD</th>
                <th>Confirm. Gate</th>
                <th>Gross P&amp;L</th>
                <th>Fee (bps / $)</th>
                <th>Quant Net P&amp;L &amp; Return</th>
              </tr>
            </thead>
            <tbody>
              {filteredLegs.map((leg) => {
                const barWidthPct = Math.max(
                  6,
                  Math.round(
                    (Math.abs(leg.netPnlUsd) / maxAbsLegPnlInCase) * 100,
                  ),
                );
                return (
                  <tr key={`${selectedCase.caseId}-${leg.legIndex}`}>
                    <td>
                      <div className="qcase-cell-stack">
                        <strong>
                          <code>Rank #{leg.quantRankInCase}</code>
                        </strong>
                        <span className="perf-dim">
                          Leg #{String(leg.legIndex).padStart(2, "0")}
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="qcase-cell-stack">
                        <span>
                          <code>{leg.quantId}</code>{" "}
                          <strong>{leg.quantName}</strong>
                        </span>
                        <span>
                          <span className="perf-badge neutral">
                            {leg.family}
                          </span>{" "}
                          <span
                            className={`perf-badge ${
                              leg.quantOutcome === "WIN" ? "win" : "err"
                            }`}
                          >
                            {leg.quantOutcome}
                          </span>
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="qcase-cell-stack">
                        <code className="qcase-formula">
                          {leg.algorithmFormula}
                        </code>
                        <span className="perf-dim">
                          {leg.parametersSummary}
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="qcase-cell-stack">
                        <span>
                          <strong>{leg.ticker}</strong>{" "}
                          <span className="perf-badge neutral">
                            {leg.sector}
                          </span>
                        </span>
                        <span className="perf-dim">{leg.assetName}</span>
                      </div>
                    </td>
                    <td>
                      <div className="qcase-cell-stack">
                        <code>{leg.signal}</code>
                        <span className="perf-dim">
                          {fmtUsd(leg.notionalUsd)} ({leg.weightPct.toFixed(2)}%
                          · {leg.quantity.toFixed(3)} u)
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="qcase-cell-stack">
                        <span>{leg.entryTimeUtc}</span>
                        <span className="perf-dim">→ {leg.exitTimeUtc}</span>
                      </div>
                    </td>
                    <td>
                      <div className="qcase-cell-stack">
                        <span>
                          {fmtUsd(leg.entryPrice)} →{" "}
                          <strong>{fmtUsd(leg.exitPrice)}</strong>
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="qcase-cell-stack">
                        <span>
                          {leg.barsEvaluated} bars · Hit{" "}
                          <strong>{leg.barHitRatePct.toFixed(1)}%</strong>
                        </span>
                        <span className="perf-dim">
                          {leg.computeMs} ms CPU time
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="qcase-cell-stack">
                        <span>
                          SR <strong>{leg.selectionSharpe.toFixed(2)}</strong> ·
                          Sortino {leg.realizedSortino.toFixed(2)}
                        </span>
                        <span className="perf-dim">
                          Max DD {leg.maxDrawdownPct.toFixed(2)}%
                        </span>
                      </div>
                    </td>
                    <td>
                      <span
                        className={
                          leg.confirmationReturnPct >= 0
                            ? "perf-pos"
                            : "perf-neg"
                        }
                      >
                        {fmtSignedPct(leg.confirmationReturnPct)}
                      </span>
                    </td>
                    <td>
                      <div className="qcase-cell-stack">
                        <span
                          className={
                            leg.grossPnlUsd >= 0 ? "perf-pos" : "perf-neg"
                          }
                        >
                          {fmtUsd(leg.grossPnlUsd, true)}
                        </span>
                        <span className="perf-dim">
                          {fmtSignedPct(leg.grossReturnPct)}
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="qcase-cell-stack">
                        <span>{fmtUsd(leg.feeUsd)}</span>
                        <span className="perf-dim">
                          {leg.feeBps.toFixed(1)} bps
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="qcase-pnl-bar-cell">
                        <div className="qcase-pnl-nums">
                          <strong
                            className={
                              leg.netPnlUsd >= 0 ? "perf-pos" : "perf-neg"
                            }
                          >
                            {fmtUsd(leg.netPnlUsd, true)}
                          </strong>
                          <span
                            className={
                              leg.netReturnPct >= 0 ? "perf-pos" : "perf-neg"
                            }
                          >
                            {fmtSignedPct(leg.netReturnPct)}
                          </span>
                        </div>
                        <div className="qcase-pnl-track">
                          <div
                            className={`qcase-pnl-fill ${
                              leg.netPnlUsd >= 0 ? "pos" : "neg"
                            }`}
                            style={{ width: `${barWidthPct}%` }}
                          />
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="qcase-tfoot-row">
                <td colSpan={4}>
                  <strong>
                    Reconciled case total ({filteredLegs.length} of{" "}
                    {selectedCase.totalLegsCount} quants shown)
                  </strong>
                </td>
                <td>
                  <strong>{fmtUsd(filteredLegsTotals.notional)}</strong>
                </td>
                <td colSpan={5}>
                  <span className="perf-dim">
                    Case Sharpe {selectedCase.portfolioSharpe.toFixed(2)} ·
                    Sortino {selectedCase.sortinoRatio.toFixed(2)} · Max DD{" "}
                    {selectedCase.maxDrawdownPct.toFixed(2)}%
                  </span>
                </td>
                <td>
                  <strong
                    className={
                      filteredLegsTotals.grossPnl >= 0 ? "perf-pos" : "perf-neg"
                    }
                  >
                    {fmtUsd(filteredLegsTotals.grossPnl, true)}
                  </strong>
                </td>
                <td>
                  <strong>{fmtUsd(filteredLegsTotals.fees)}</strong>
                </td>
                <td>
                  <strong
                    className={
                      filteredLegsTotals.netPnl >= 0 ? "perf-pos" : "perf-neg"
                    }
                  >
                    {fmtUsd(filteredLegsTotals.netPnl, true)} (
                    {fmtSignedPct(selectedCase.netReturnPct)})
                  </strong>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <section className="ops-panel qcase-leaderboard-panel">
        <div className="panel-heading">
          <div>
            <h2>
              Aggregate per-quant strategy attribution across all 30 cases (
              <code>M01</code>–<code>M24</code>)
            </h2>
            <p>
              Cumulative performance, win/loss rate, exact signal equation, and
              best/worst case for every single quant model across all{" "}
              {QUANT_BENCHMARK_SUMMARY.totalLegExecutions} executions.
            </p>
          </div>
        </div>
        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Per-quant model aggregate attribution across 30 cases"
        >
          <table className="qcase-legs-table">
            <thead>
              <tr>
                <th>Quant ID &amp; Strategy</th>
                <th>Family</th>
                <th>Exact Signal Formula &amp; Parameters</th>
                <th>Cases Used</th>
                <th>Quant Win / Loss</th>
                <th>Gross P&amp;L</th>
                <th>Total Fees</th>
                <th>Cumulative Net P&amp;L</th>
                <th>Mean Return</th>
                <th>Mean Sharpe / Worst DD</th>
                <th>Best &amp; Worst Case</th>
              </tr>
            </thead>
            <tbody>
              {QUANT_MODEL_LEADERBOARD.map((row) => (
                <tr key={row.quantId}>
                  <td>
                    <div className="qcase-cell-stack">
                      <span>
                        <code>{row.quantId}</code>{" "}
                        <strong>{row.quantName}</strong>
                      </span>
                    </div>
                  </td>
                  <td>
                    <span className="perf-badge neutral">{row.family}</span>
                  </td>
                  <td>
                    <div className="qcase-cell-stack">
                      <code className="qcase-formula">
                        {row.algorithmFormula}
                      </code>
                      <span className="perf-dim">{row.parametersSummary}</span>
                    </div>
                  </td>
                  <td>
                    <strong>
                      {row.casesUsedCount} /{" "}
                      {QUANT_BENCHMARK_SUMMARY.totalCases}
                    </strong>{" "}
                    cases
                  </td>
                  <td>
                    <div className="qcase-cell-stack">
                      <span>
                        <span className="perf-pos">
                          {row.winningRunsCount}W
                        </span>{" "}
                        /{" "}
                        <span className="perf-neg">{row.losingRunsCount}L</span>
                      </span>
                      <span className="perf-dim">
                        {row.winRatePct.toFixed(1)}% win rate
                      </span>
                    </div>
                  </td>
                  <td>
                    <span
                      className={
                        row.totalGrossPnlUsd >= 0 ? "perf-pos" : "perf-neg"
                      }
                    >
                      {fmtUsd(row.totalGrossPnlUsd, true)}
                    </span>
                  </td>
                  <td>{fmtUsd(row.totalFeesUsd)}</td>
                  <td>
                    <strong
                      className={
                        row.totalNetPnlUsd >= 0 ? "perf-pos" : "perf-neg"
                      }
                    >
                      {fmtUsd(row.totalNetPnlUsd, true)}
                    </strong>
                  </td>
                  <td>
                    <span
                      className={
                        row.meanNetReturnPct >= 0 ? "perf-pos" : "perf-neg"
                      }
                    >
                      {fmtSignedPct(row.meanNetReturnPct)}
                    </span>
                  </td>
                  <td>
                    <div className="qcase-cell-stack">
                      <span>SR {row.meanSharpe.toFixed(2)}</span>
                      <span className="perf-dim">
                        Worst DD {row.worstMaxDrawdownPct.toFixed(1)}%
                      </span>
                    </div>
                  </td>
                  <td>
                    <div className="qcase-cell-stack">
                      <button
                        type="button"
                        className="qcase-link-btn"
                        onClick={() => selectAndInspect(row.bestCaseId)}
                      >
                        Best: <code>{row.bestCaseId}</code>{" "}
                        <span className="perf-pos">
                          {fmtUsd(row.bestCaseNetPnlUsd, true)}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="qcase-link-btn"
                        onClick={() => selectAndInspect(row.worstCaseId)}
                      >
                        Worst: <code>{row.worstCaseId}</code>{" "}
                        <span className="perf-neg">
                          {fmtUsd(row.worstCaseNetPnlUsd, true)}
                        </span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
