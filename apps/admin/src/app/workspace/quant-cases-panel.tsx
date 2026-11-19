"use client";
import { useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ChevronLeft,
  ChevronRight,
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
    "ALL" | "PROFIT" | "LOSS"
  >("ALL");

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
        item.workerCluster.toLowerCase().includes(q)
      ) {
        return true;
      }
      return item.legs.some(
        (leg) =>
          leg.ticker.toLowerCase().includes(q) ||
          leg.assetName.toLowerCase().includes(q) ||
          leg.quantId.toLowerCase().includes(q) ||
          leg.quantName.toLowerCase().includes(q) ||
          leg.family.toLowerCase().includes(q),
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
    return selectedCase.legs.filter((leg) => {
      if (legSectorFilter !== "ALL" && leg.sector !== legSectorFilter) {
        return false;
      }
      if (legFamilyFilter !== "ALL" && leg.family !== legFamilyFilter) {
        return false;
      }
      if (legOutcomeFilter === "PROFIT" && leg.netPnlUsd <= 0) {
        return false;
      }
      if (legOutcomeFilter === "LOSS" && leg.netPnlUsd >= 0) {
        return false;
      }
      return true;
    });
  }, [legFamilyFilter, legOutcomeFilter, legSectorFilter, selectedCase]);

  const filteredLegsTotals = useMemo(() => {
    const notional = filteredLegs.reduce((acc, l) => acc + l.notionalUsd, 0);
    const fees = filteredLegs.reduce((acc, l) => acc + l.feeUsd, 0);
    const netPnl = filteredLegs.reduce((acc, l) => acc + l.netPnlUsd, 0);
    return {
      notional: Number(notional.toFixed(2)),
      fees: Number(fees.toFixed(2)),
      netPnl: Number(netPnl.toFixed(2)),
    };
  }, [filteredLegs]);

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
      cases: QUANT_PERFORMANCE_CASES,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "quant-performance-30-cases.json";
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
      "quant_id",
      "quant_name",
      "family",
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
      "compute_ms",
      "selection_sharpe",
      "max_drawdown_pct",
      "confirmation_return_pct",
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
            leg.quantId,
            leg.quantName,
            leg.family,
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
            leg.computeMs,
            leg.selectionSharpe,
            leg.maxDrawdownPct,
            leg.confirmationReturnPct,
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
    anchor.download = "quant-performance-660-legs.csv";
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
            {QUANT_BENCHMARK_SUMMARY.totalLegExecutions} total execution legs
          </small>
        </section>
        <section>
          <span>Profit / loss split</span>
          <strong>
            {QUANT_BENCHMARK_SUMMARY.profitCases}W /{" "}
            {QUANT_BENCHMARK_SUMMARY.lossCases}L
          </strong>
          <small>
            <strong className="perf-pos">
              {QUANT_BENCHMARK_SUMMARY.profitRatePct.toFixed(1)}% profit
            </strong>{" "}
            ({QUANT_BENCHMARK_SUMMARY.profitCases} cases) ·{" "}
            <strong className="perf-neg">
              {QUANT_BENCHMARK_SUMMARY.lossRatePct.toFixed(1)}% loss
            </strong>{" "}
            ({QUANT_BENCHMARK_SUMMARY.lossCases} cases)
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
            $100,000.00 starting capital per case · net of{" "}
            {fmtUsd(QUANT_BENCHMARK_SUMMARY.totalFeesUsd)} fees
          </small>
        </section>
        <section>
          <span>Mean portfolio Sharpe</span>
          <strong>{QUANT_BENCHMARK_SUMMARY.meanSharpe.toFixed(2)}</strong>
          <small>
            Set <code>daily-v1+ext24</code> · Stable (v1) &amp; Aggressive (v2)
            policies
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
              21 profitable cases (70.0%) and 9 loss cases (30.0%). Select any
              case row to inspect all 22 distinct quant strategies, 22 tickers,
              UTC entry/exit timestamps, prices, fees, and leg P&amp;L below.
            </p>
          </div>
          <div className="perf-actions">
            <button
              type="button"
              className="button secondary"
              onClick={() => selectAndInspect(selectedCase.caseId)}
            >
              <ArrowDown size={15} />
              Inspect {selectedCase.caseId} (22 legs)
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={exportAllLegsCsv}
            >
              <FileSpreadsheet size={15} />
              Export 660 legs CSV
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
          <div className="qcase-outcome-pills" role="group" aria-label="Filter by case outcome">
            <button
              type="button"
              className={`perf-tab ${outcomeFilter === "ALL" ? "active" : ""}`}
              onClick={() => setOutcomeFilter("ALL")}
            >
              All cases ({QUANT_BENCHMARK_SUMMARY.totalCases})
            </button>
            <button
              type="button"
              className={`perf-tab ${outcomeFilter === "PROFIT" ? "active" : ""}`}
              onClick={() => setOutcomeFilter("PROFIT")}
            >
              <TrendingUp size={14} />
              Profitable ({QUANT_BENCHMARK_SUMMARY.profitCases} ·{" "}
              {QUANT_BENCHMARK_SUMMARY.profitRatePct.toFixed(0)}%)
            </button>
            <button
              type="button"
              className={`perf-tab ${outcomeFilter === "LOSS" ? "active" : ""}`}
              onClick={() => setOutcomeFilter("LOSS")}
            >
              <TrendingDown size={14} />
              Loss ({QUANT_BENCHMARK_SUMMARY.lossCases} ·{" "}
              {QUANT_BENCHMARK_SUMMARY.lossRatePct.toFixed(0)}%)
            </button>
          </div>

          <div className="perf-filters">
            <div className="qcase-search-wrap">
              <Search size={14} />
              <input
                type="search"
                aria-label="Search cases, tickers, or quant strategies"
                placeholder="Search case ID, ticker (NVDA, BTC/USD), quant (M01, Kalman)…"
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
                <th>Mode &amp; Policy</th>
                <th>Execution Window (UTC)</th>
                <th>Worker &amp; Latency</th>
                <th>Quants × Tickers</th>
                <th>Start → End Capital</th>
                <th>Net P&amp;L ($ / %)</th>
                <th>Fees</th>
                <th>Sharpe / Sortino / Max DD</th>
                <th>Market Regime &amp; Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredCases.map((c) => {
                const isSelected = c.caseId === selectedCase.caseId;
                return (
                  <tr
                    key={c.caseId}
                    className={`qcase-row ${isSelected ? "selected" : ""}`}
                    onClick={() => setSelectedCaseId(c.caseId)}
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
                        {c.outcome}
                      </span>
                    </td>
                    <td>
                      <div className="qcase-cell-stack">
                        <span
                          className={`perf-badge ${
                            c.mode === "Aggressive" ? "aggr" : "neutral"
                          }`}
                        >
                          {c.mode}
                        </span>
                        <span className="perf-dim">
                          Policy v{c.policyVersion} · {c.modelSetVersion}
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="qcase-cell-stack">
                        <span>{c.startedAtUtc}</span>
                        <span className="perf-dim">→ {c.completedAtUtc}</span>
                      </div>
                    </td>
                    <td>
                      <div className="qcase-cell-stack">
                        <code>{c.workerCluster}</code>
                        <span className="perf-dim">
                          {c.totalComputeSec.toFixed(2)}s compute
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="qcase-cell-stack">
                        <strong>22 quants · 22 tickers</strong>
                        <span className="perf-dim">
                          {c.winningLegsCount}/{c.totalLegsCount} winning legs (
                          {c.legWinRatePct.toFixed(1)}%)
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
                          Deployed {fmtUsd(c.deployedCapitalUsd)}
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
                    <td>{fmtUsd(c.totalFeesUsd)}</td>
                    <td>
                      <div className="qcase-cell-stack">
                        <span>
                          Sharpe <strong>{c.portfolioSharpe.toFixed(2)}</strong>{" "}
                          · Sortino {c.sortinoRatio.toFixed(2)}
                        </span>
                        <span className="perf-dim">
                          Max DD {c.maxDrawdownPct.toFixed(2)}%
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="qcase-regime-cell">
                        <span className="qcase-regime-note" title={c.regimeNote}>
                          {c.regimeNote}
                        </span>
                        <button
                          type="button"
                          className={`qcase-inspect-btn ${
                            isSelected ? "active" : ""
                          }`}
                          onClick={(e) => {
                            e.stopPropagation();
                            selectAndInspect(c.caseId);
                          }}
                        >
                          {isSelected ? "Viewing 22 legs ↓" : "Inspect 22 legs"}
                        </button>
                      </div>
                    </td>
                  </tr>
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
                <code>{selectedCase.caseId}</code> — All 22 Quant × Ticker
                Execution Legs
              </h2>
              <span
                className={`perf-badge ${
                  selectedCase.outcome === "PROFIT" ? "win" : "err"
                }`}
              >
                {selectedCase.outcome} ·{" "}
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
                  {item.caseId} ({item.cycleDate}) · {item.outcome}{" "}
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
              <Cpu size={11} /> Worker node &amp; cycle ID
            </span>
            <span>
              <code>{selectedCase.workerCluster}</code> ·{" "}
              <code>{selectedCase.cycleId}</code>
            </span>
          </div>
          <div>
            <span className="perf-gov-label">
              <Layers size={11} /> Capital &amp; fee reconciliation
            </span>
            <span>
              Start {fmtUsd(selectedCase.startingCapitalUsd)} · Deployed{" "}
              {fmtUsd(selectedCase.deployedCapitalUsd)} · Fees{" "}
              {fmtUsd(selectedCase.totalFeesUsd)} · End{" "}
              <strong>{fmtUsd(selectedCase.endingCapitalUsd)}</strong>
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
              aria-label="Filter legs by asset sector"
              value={legSectorFilter}
              onChange={(e) =>
                setLegSectorFilter(
                  e.target.value as "ALL" | "stock" | "bond" | "crypto",
                )
              }
            >
              <option value="ALL">All sectors (22 legs)</option>
              <option value="stock">Equities / Stocks</option>
              <option value="bond">Treasury &amp; Credit Bond ETFs</option>
              <option value="crypto">Crypto USD Pairs</option>
            </select>
            <select
              aria-label="Filter legs by quant strategy family"
              value={legFamilyFilter}
              onChange={(e) => setLegFamilyFilter(e.target.value)}
            >
              <option value="ALL">All strategy families</option>
              <option value="Trend">Trend</option>
              <option value="Momentum">Momentum</option>
              <option value="Mean Reversion">Mean Reversion</option>
              <option value="Breakout">Breakout</option>
              <option value="Statistical">Statistical</option>
              <option value="Regime">Regime</option>
            </select>
            <select
              aria-label="Filter legs by leg P&L"
              value={legOutcomeFilter}
              onChange={(e) =>
                setLegOutcomeFilter(
                  e.target.value as "ALL" | "PROFIT" | "LOSS",
                )
              }
            >
              <option value="ALL">All leg outcomes</option>
              <option value="PROFIT">Winning legs only</option>
              <option value="LOSS">Losing legs only</option>
            </select>
          </div>
          <span className="perf-dim qcase-leg-count">
            Showing {filteredLegs.length} of {selectedCase.totalLegsCount}{" "}
            constituent quant × ticker legs
          </span>
        </div>

        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label={`All 22 quant and ticker execution legs for ${selectedCase.caseId}`}
        >
          <table className="qcase-legs-table">
            <thead>
              <tr>
                <th>Leg</th>
                <th>Quant Strategy</th>
                <th>Family</th>
                <th>Ticker &amp; Instrument</th>
                <th>Sector</th>
                <th>Signal &amp; Weight</th>
                <th>Entry → Exit Timestamp (UTC)</th>
                <th>Entry → Exit Price</th>
                <th>Qty &amp; Notional</th>
                <th>Bars &amp; Latency</th>
                <th>Sel. Sharpe</th>
                <th>Max DD</th>
                <th>Confirm. Gate</th>
                <th>Fee (bps / $)</th>
                <th>Net P&amp;L ($)</th>
                <th>Net Return</th>
              </tr>
            </thead>
            <tbody>
              {filteredLegs.map((leg) => (
                <tr key={`${selectedCase.caseId}-${leg.legIndex}`}>
                  <td>
                    <code>#{String(leg.legIndex).padStart(2, "0")}</code>
                  </td>
                  <td>
                    <div className="qcase-cell-stack">
                      <span>
                        <code>{leg.quantId}</code>{" "}
                        <strong>{leg.quantName}</strong>
                      </span>
                    </div>
                  </td>
                  <td>
                    <span className="perf-badge neutral">{leg.family}</span>
                  </td>
                  <td>
                    <div className="qcase-cell-stack">
                      <strong>{leg.ticker}</strong>
                      <span className="perf-dim">{leg.assetName}</span>
                    </div>
                  </td>
                  <td>
                    <span className="perf-badge neutral">{leg.sector}</span>
                  </td>
                  <td>
                    <div className="qcase-cell-stack">
                      <code>{leg.signal}</code>
                      <span className="perf-dim">
                        {leg.weightPct.toFixed(2)}% weight
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
                      <span>{fmtUsd(leg.notionalUsd)}</span>
                      <span className="perf-dim">
                        {leg.quantity.toFixed(4)} units
                      </span>
                    </div>
                  </td>
                  <td>
                    <div className="qcase-cell-stack">
                      <span>{leg.barsEvaluated} bars</span>
                      <span className="perf-dim">{leg.computeMs} ms</span>
                    </div>
                  </td>
                  <td>{leg.selectionSharpe.toFixed(2)}</td>
                  <td>{leg.maxDrawdownPct.toFixed(2)}%</td>
                  <td>
                    <span
                      className={
                        leg.confirmationReturnPct >= 0 ? "perf-pos" : "perf-neg"
                      }
                    >
                      {fmtSignedPct(leg.confirmationReturnPct)}
                    </span>
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
                    <span
                      className={leg.netPnlUsd >= 0 ? "perf-pos" : "perf-neg"}
                    >
                      {fmtUsd(leg.netPnlUsd, true)}
                    </span>
                  </td>
                  <td>
                    <span
                      className={
                        leg.netReturnPct >= 0 ? "perf-pos" : "perf-neg"
                      }
                    >
                      {fmtSignedPct(leg.netReturnPct)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="qcase-tfoot-row">
                <td colSpan={8}>
                  <strong>
                    Reconciled case total ({filteredLegs.length} of{" "}
                    {selectedCase.totalLegsCount} legs shown)
                  </strong>
                </td>
                <td>
                  <strong>{fmtUsd(filteredLegsTotals.notional)}</strong>
                </td>
                <td colSpan={4}>
                  <span className="perf-dim">
                    Portfolio Sharpe {selectedCase.portfolioSharpe.toFixed(2)} ·
                    Sortino {selectedCase.sortinoRatio.toFixed(2)} · Max DD{" "}
                    {selectedCase.maxDrawdownPct.toFixed(2)}%
                  </span>
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
                    {fmtUsd(filteredLegsTotals.netPnl, true)}
                  </strong>
                </td>
                <td>
                  <strong
                    className={
                      selectedCase.netReturnPct >= 0 ? "perf-pos" : "perf-neg"
                    }
                  >
                    {fmtSignedPct(selectedCase.netReturnPct)}
                  </strong>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
    </div>
  );
}
