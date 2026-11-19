"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Award,
  BarChart3,
  CheckCircle2,
  CircleAlert,
  Clock,
  Cpu,
  Download,
  FileSpreadsheet,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { QUANT_BENCHMARK_SUMMARY } from "@/lib/quant-cases-data";
import { QuantCasesPanel } from "./quant-cases-panel";

export type CycleOverviewItem = {
  id: string;
  cycle_date: string;
  created_at: string;
  model_set_version: string;
  policy_version: number;
  units_total: number;
  units_completed: number;
  units_leased: number;
  units_queued: number;
  stable_winners_count: number;
  aggressive_winners_count: number;
};

export type ModelSummaryRow = {
  model_id: string;
  label: string;
  is_benchmark: boolean;
  evaluated_symbols: number;
  stable_wins: number;
  aggressive_wins: number;
  positive_confirmation_count: number;
  mean_selection_net_return: string | null;
  mean_selection_sharpe: string | null;
  worst_selection_max_drawdown: string | null;
  mean_confirmation_net_return: string | null;
  mean_next_position: string | null;
};

export type WorkUnitRow = {
  unit_id: string;
  symbol: string;
  sector: string;
  mean_dollar_volume: string;
  mean_abs_move: string | null;
  bar_count: number;
  status: "completed" | "leased" | "lease_expired" | "queued";
  leased_to: string | null;
  lease_expires_at: string | null;
  completed_at: string | null;
  turnaround_seconds: number | null;
  stable_winner: string | null;
  aggressive_winner: string | null;
};

export type ModelResultRow = {
  symbol: string;
  sector: string;
  model_id: string;
  model_label: string;
  selection_net_return: string;
  selection_sharpe: string | null;
  selection_max_drawdown: string;
  confirmation_net_return: string;
  next_position: string;
  is_stable_winner: boolean;
  is_aggressive_winner: boolean;
};

export type SectorScreenMeta = {
  universe?: string;
  feed?: string;
  coverage?: Record<string, number>;
  excluded?: Record<string, string>;
};

export type SelectedCycleDetail = {
  id: string;
  cycle_date: string;
  created_at: string;
  model_set_version: string;
  policy_version: number;
  policy: {
    version: number;
    stable_max_drawdown: number;
    stable_deploy: number;
    stable_ticker_cap: number;
    aggressive_deploy: number;
    aggressive_ticker_cap: number;
    confirmation_bars: number;
  };
  policy_hash: string;
  costs: {
    stock: number;
    bond: number;
    crypto: number;
  };
  costs_hash: string;
  screens: Record<string, SectorScreenMeta>;
  summary: {
    units_total: number;
    units_completed: number;
    units_leased: number;
    units_lease_expired: number;
    units_queued: number;
    completion_pct: number;
    model_evaluations_stored: number;
    stable_confirmed_count: number;
    aggressive_confirmed_count: number;
    first_completed_at: string | null;
    last_completed_at: string | null;
  };
  model_summaries: ModelSummaryRow[];
  work_units: WorkUnitRow[];
  model_results: ModelResultRow[];
};

export type WorkerNodeRow = {
  worker_id: string;
  created_at: string;
  revoked_at: string | null;
  active_leases: number;
  completed_units_in_cycle: number;
  completed_units_total: number;
  last_completed_at: string | null;
};

export type QuantEventRow = {
  id: string;
  occurred_at: string;
  source: string;
  event: string;
  detail: Record<string, unknown>;
};

export type QuantPerformanceResponse = {
  cycles: CycleOverviewItem[];
  selected_cycle: SelectedCycleDetail | null;
  worker_nodes: WorkerNodeRow[];
  event_log: QuantEventRow[];
};

type SubView = "models" | "matrix" | "units" | "events";

const utcStamp = (value: string | null) =>
  value
    ? `${new Date(value).toISOString().slice(0, 19).replace("T", " ")} UTC`
    : "—";

const fmtPct = (raw: string | null, signed = true): string => {
  if (raw === null || raw === "") return "—";
  const num = Number(raw);
  if (!Number.isFinite(num)) return raw;
  const pct = num * 100;
  const prefix = signed && pct > 0 ? "+" : "";
  return `${prefix}${pct.toFixed(2)}%`;
};

const fmtFixed = (raw: string | null, digits = 2): string => {
  if (raw === null || raw === "") return "—";
  const num = Number(raw);
  if (!Number.isFinite(num)) return raw;
  return num.toFixed(digits);
};

const fmtDollarVol = (raw: string): string => {
  const num = Number(raw);
  if (!Number.isFinite(num)) return raw;
  if (num >= 1_000_000_000) return `$${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(2)}`;
};

function summarizeEventDetail(detail: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof detail.symbol === "string") parts.push(`symbol=${detail.symbol}`);
  if (typeof detail.sector === "string") parts.push(`sector=${detail.sector}`);
  if (typeof detail.cycle_date === "string")
    parts.push(`cycle=${detail.cycle_date}`);
  if (typeof detail.stable_winner === "string")
    parts.push(`stable=${detail.stable_winner}`);
  if (typeof detail.aggressive_winner === "string")
    parts.push(`aggressive=${detail.aggressive_winner}`);
  if (typeof detail.models_evaluated === "number")
    parts.push(`models=${detail.models_evaluated}`);
  if (typeof detail.units_total === "number")
    parts.push(`units=${detail.units_total}`);
  if (typeof detail.worker_id === "string")
    parts.push(`node=${detail.worker_id.slice(0, 8)}…`);
  if (typeof detail.reason === "string") parts.push(`reason="${detail.reason}"`);
  if (typeof detail.error_type === "string")
    parts.push(`error=${detail.error_type}`);
  if (typeof detail.execution_id === "string")
    parts.push(`exec=${detail.execution_id}`);
  return parts.length ? parts.join(" · ") : "—";
}

export function PerformanceLog({
  request,
  onUnauthorized,
  defaultMode = "cases",
}: {
  request: (path: string, init?: RequestInit) => Promise<Response>;
  onUnauthorized: () => void;
  defaultMode?: "cases" | "live";
}) {
  const [mode, setMode] = useState<"cases" | "live">(defaultMode);
  const [data, setData] = useState<QuantPerformanceResponse | null>(null);
  const [selectedCycleId, setSelectedCycleId] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const [subView, setSubView] = useState<SubView>("models");

  const [sectorFilter, setSectorFilter] = useState<string>("all");
  const [symbolFilter, setSymbolFilter] = useState<string>("");
  const [modelFilter, setModelFilter] = useState<string>("all");
  const [winnersOnly, setWinnersOnly] = useState<boolean>(false);
  const [eventSourceFilter, setEventSourceFilter] = useState<string>("all");

  const fetchTelemetry = useCallback(
    async (cycleId: string): Promise<QuantPerformanceResponse | "unauthorized"> => {
      const query = cycleId ? `?cycle_id=${encodeURIComponent(cycleId)}` : "";
      const response = await request(`/api/quant-performance${query}`, {
        cache: "no-store",
        redirect: "error",
      });
      if (response.status === 401 || response.status === 403) {
        return "unauthorized";
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          detail?: string;
        };
        throw new Error(
          body.detail ||
            "Quant performance telemetry could not be loaded. Try refreshing.",
        );
      }
      return (await response.json()) as QuantPerformanceResponse;
    },
    [request],
  );

  const loadPerformance = useCallback(
    async (cycleId: string) => {
      setLoading(true);
      setError("");
      try {
        const result = await fetchTelemetry(cycleId);
        if (result === "unauthorized") {
          onUnauthorized();
          return;
        }
        setData(result);
        if (result.selected_cycle && !cycleId) {
          setSelectedCycleId(result.selected_cycle.id);
        }
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : "The operations service could not be reached.",
        );
      } finally {
        setLoading(false);
      }
    },
    [fetchTelemetry, onUnauthorized],
  );

  useEffect(() => {
    let cancelled = false;
    void fetchTelemetry("")
      .then((result) => {
        if (cancelled) return;
        if (result === "unauthorized") {
          onUnauthorized();
          return;
        }
        setData(result);
        if (result.selected_cycle) {
          setSelectedCycleId(result.selected_cycle.id);
        }
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(
          caught instanceof Error
            ? caught.message
            : "The operations service could not be reached.",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchTelemetry, onUnauthorized]);

  const cycle = data?.selected_cycle ?? null;

  const filteredResults = useMemo(() => {
    if (!cycle) return [];
    const symNeedle = symbolFilter.trim().toUpperCase();
    return cycle.model_results.filter((row) => {
      if (sectorFilter !== "all" && row.sector !== sectorFilter) return false;
      if (modelFilter !== "all" && row.model_id !== modelFilter) return false;
      if (symNeedle && !row.symbol.toUpperCase().includes(symNeedle))
        return false;
      if (winnersOnly && !row.is_stable_winner && !row.is_aggressive_winner)
        return false;
      return true;
    });
  }, [cycle, modelFilter, sectorFilter, symbolFilter, winnersOnly]);

  const filteredEvents = useMemo(() => {
    if (!data) return [];
    if (eventSourceFilter === "all") return data.event_log;
    return data.event_log.filter((item) => item.source === eventSourceFilter);
  }, [data, eventSourceFilter]);

  const eventSources = useMemo(() => {
    if (!data) return [];
    return Array.from(new Set(data.event_log.map((item) => item.source))).sort();
  }, [data]);

  function exportJson() {
    if (!data) return;
    const tag = cycle ? cycle.cycle_date : "empty";
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `quant-performance-${tag}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="perf-root">
      <div
        className="perf-mode-switcher"
        role="tablist"
        aria-label="Performance log data source"
      >
        <button
          type="button"
          role="tab"
          aria-selected={mode === "cases"}
          className={`perf-mode-btn ${mode === "cases" ? "active" : ""}`}
          onClick={() => setMode("cases")}
        >
          <Award size={16} />
          <span>
            Quant Case Log ({QUANT_BENCHMARK_SUMMARY.totalCases} cases ·{" "}
            {QUANT_BENCHMARK_SUMMARY.profitRatePct.toFixed(0)}% profit /{" "}
            {QUANT_BENCHMARK_SUMMARY.lossRatePct.toFixed(0)}% loss)
          </span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "live"}
          className={`perf-mode-btn ${mode === "live" ? "active" : ""}`}
          onClick={() => setMode("live")}
        >
          <Activity size={16} />
          <span>
            Live DB Cycle Telemetry
            {data ? ` (${data.cycles.length} cycles)` : ""}
          </span>
        </button>
      </div>

      {mode === "cases" ? (
        <QuantCasesPanel />
      ) : loading && !data ? (
        <section className="ops-panel">
          <div className="ops-empty" role="status">
            <LoaderCircle className="spin" size={26} />
            <h3>Loading live cycle telemetry…</h3>
            <p>
              Collecting evaluation cycle metrics, model backtests, worker node
              throughput, and execution logs.
            </p>
          </div>
        </section>
      ) : (
        <>
          {error && (
            <div className="error" role="alert">
              <CircleAlert size={17} />
              {error}
              <button onClick={() => void loadPerformance(selectedCycleId)}>
                Try again
              </button>
            </div>
          )}

          <div className="perf-toolbar">
        <div className="perf-cycle-picker">
          <label htmlFor="perf-cycle-select">Evaluation cycle</label>
          <select
            id="perf-cycle-select"
            value={selectedCycleId}
            disabled={!data?.cycles.length || loading}
            onChange={(e) => {
              const nextId = e.target.value;
              setSelectedCycleId(nextId);
              void loadPerformance(nextId);
            }}
          >
            {data?.cycles.length ? (
              data.cycles.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.cycle_date} · {item.model_set_version} · Policy v
                  {item.policy_version} ({item.units_completed}/
                  {item.units_total} units)
                </option>
              ))
            ) : (
              <option value="">No evaluation cycles recorded yet</option>
            )}
          </select>
        </div>

        <div className="perf-actions">
          <button
            type="button"
            className="button secondary"
            disabled={!data}
            onClick={exportJson}
          >
            <Download size={15} />
            Export JSON
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={loading}
            onClick={() => void loadPerformance(selectedCycleId)}
          >
            <RefreshCw size={15} className={loading ? "spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {!cycle ? (
        <section className="ops-panel">
          <div className="ops-empty">
            <BarChart3 size={30} />
            <h2>No evaluation cycle metrics recorded yet</h2>
            <p>
              Once <code>market-ingest</code> publishes a daily evaluation cycle
              and CPU worker nodes upload model evaluations via{" "}
              <code>/worker/v1</code>, every model’s return, Sharpe ratio,
              drawdown, confirmation gate, and node turnaround appears here.
            </p>
          </div>
        </section>
      ) : (
        <>
          <div className="ops-stats perf-stats">
            <section>
              <span>Work unit completion</span>
              <strong>
                {cycle.summary.units_completed} / {cycle.summary.units_total}
              </strong>
              <small>
                {cycle.summary.completion_pct}% done ·{" "}
                {cycle.summary.units_leased} leased ·{" "}
                {cycle.summary.units_queued +
                  cycle.summary.units_lease_expired}{" "}
                pending
              </small>
            </section>
            <section>
              <span>Model evaluations stored</span>
              <strong>{cycle.summary.model_evaluations_stored}</strong>
              <small>
                Set <code>{cycle.model_set_version}</code> across{" "}
                {cycle.summary.units_completed} completed symbols
              </small>
            </section>
            <section>
              <span>Confirmed winners</span>
              <strong>
                {cycle.summary.stable_confirmed_count}S /{" "}
                {cycle.summary.aggressive_confirmed_count}A
              </strong>
              <small>
                Stable (DD ≤ {(cycle.policy.stable_max_drawdown * 100).toFixed(0)}
                %) vs. Aggressive ({cycle.policy.confirmation_bars}-bar gate)
              </small>
            </section>
            <section>
              <span>Pinned cycle governance</span>
              <strong className="small-stat">
                Cycle {cycle.cycle_date} · v{cycle.policy_version}
              </strong>
              <small>
                policy <code>{cycle.policy_hash.slice(0, 8)}</code> · costs{" "}
                <code>{cycle.costs_hash.slice(0, 8)}</code>
              </small>
            </section>
          </div>

          <section className="ops-panel perf-governance">
            <div className="perf-gov-grid">
              <div>
                <span className="perf-gov-label">Cycle ID</span>
                <code>{cycle.id}</code>
              </div>
              <div>
                <span className="perf-gov-label">Trade costs (per side)</span>
                <span>
                  Stock {(cycle.costs.stock * 10000).toFixed(1)} bps · Bond{" "}
                  {(cycle.costs.bond * 10000).toFixed(1)} bps · Crypto{" "}
                  {(cycle.costs.crypto * 10000).toFixed(1)} bps
                </span>
              </div>
              <div>
                <span className="perf-gov-label">Mode policy v{cycle.policy_version}</span>
                <span>
                  Stable deploy {(cycle.policy.stable_deploy * 100).toFixed(0)}%
                  (cap {(cycle.policy.stable_ticker_cap * 100).toFixed(0)}%) ·
                  Aggressive deploy{" "}
                  {(cycle.policy.aggressive_deploy * 100).toFixed(0)}%
                </span>
              </div>
              <div>
                <span className="perf-gov-label">Screen coverage</span>
                <span>
                  {(["stock", "bond", "crypto"] as const)
                    .map((sec) => {
                      const cov = cycle.screens[sec]?.coverage;
                      return cov
                        ? `${sec}: ${cov.selected ?? 0}/${cov.provider_listed ?? 0}`
                        : `${sec}: n/a`;
                    })
                    .join(" · ")}
                </span>
              </div>
            </div>
          </section>

          <div className="perf-tabs" role="tablist" aria-label="Quant performance views">
            {(
              [
                {
                  id: "models",
                  label: `Model summary (${cycle.model_summaries.length})`,
                  icon: Award,
                },
                {
                  id: "matrix",
                  label: `Symbol × Model metrics (${cycle.model_results.length})`,
                  icon: FileSpreadsheet,
                },
                {
                  id: "units",
                  label: `Work units & CPU nodes (${cycle.work_units.length})`,
                  icon: Cpu,
                },
                {
                  id: "events",
                  label: `Event log (${data?.event_log.length ?? 0})`,
                  icon: Activity,
                },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={subView === tab.id}
                className={`perf-tab ${subView === tab.id ? "active" : ""}`}
                onClick={() => setSubView(tab.id)}
              >
                <tab.icon size={15} />
                {tab.label}
              </button>
            ))}
          </div>

          {subView === "models" && (
            <section className="ops-panel">
              <div className="panel-heading">
                <div>
                  <h2>Model performance summary — Cycle {cycle.cycle_date}</h2>
                  <p>
                    Aggregated strictly within evaluation cycle{" "}
                    <code>{cycle.id.slice(0, 8)}</code> under pinned{" "}
                    <code>{cycle.model_set_version}</code>, policy{" "}
                    <code>v{cycle.policy_version}</code>, and identical bars.
                  </p>
                </div>
              </div>
              <div
                className="table-scroll"
                tabIndex={0}
                role="region"
                aria-label="Model performance summary table"
              >
                <table>
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Strategy</th>
                      <th>Evaluated</th>
                      <th>Stable wins</th>
                      <th>Aggressive wins</th>
                      <th>Confirm &gt; 0</th>
                      <th>Mean sel. return</th>
                      <th>Mean sel. Sharpe</th>
                      <th>Worst max DD</th>
                      <th>Mean confirm. return</th>
                      <th>Mean next pos.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cycle.model_summaries.map((m) => (
                      <tr key={m.model_id}>
                        <td>
                          <code>{m.model_id}</code>
                        </td>
                        <td>
                          <span className="perf-model-name">
                            {m.label}
                            {m.is_benchmark && (
                              <span className="perf-badge neutral">
                                Benchmark
                              </span>
                            )}
                          </span>
                        </td>
                        <td>{m.evaluated_symbols}</td>
                        <td>
                          {m.is_benchmark ? (
                            "—"
                          ) : m.stable_wins > 0 ? (
                            <span className="perf-badge win">
                              {m.stable_wins}
                            </span>
                          ) : (
                            "0"
                          )}
                        </td>
                        <td>
                          {m.is_benchmark ? (
                            "—"
                          ) : m.aggressive_wins > 0 ? (
                            <span className="perf-badge aggr">
                              {m.aggressive_wins}
                            </span>
                          ) : (
                            "0"
                          )}
                        </td>
                        <td>
                          {m.evaluated_symbols
                            ? `${m.positive_confirmation_count} / ${m.evaluated_symbols}`
                            : "—"}
                        </td>
                        <td title={m.mean_selection_net_return ?? undefined}>
                          <span
                            className={
                              Number(m.mean_selection_net_return) > 0
                                ? "perf-pos"
                                : Number(m.mean_selection_net_return) < 0
                                  ? "perf-neg"
                                  : ""
                            }
                          >
                            {fmtPct(m.mean_selection_net_return)}
                          </span>
                        </td>
                        <td title={m.mean_selection_sharpe ?? "Undefined"}>
                          {m.evaluated_symbols === 0
                            ? "—"
                            : m.mean_selection_sharpe === null
                              ? "Undefined (σ=0)"
                              : fmtFixed(m.mean_selection_sharpe, 3)}
                        </td>
                        <td title={m.worst_selection_max_drawdown ?? undefined}>
                          {fmtPct(m.worst_selection_max_drawdown, false)}
                        </td>
                        <td title={m.mean_confirmation_net_return ?? undefined}>
                          <span
                            className={
                              Number(m.mean_confirmation_net_return) > 0
                                ? "perf-pos"
                                : Number(m.mean_confirmation_net_return) < 0
                                  ? "perf-neg"
                                  : ""
                            }
                          >
                            {fmtPct(m.mean_confirmation_net_return)}
                          </span>
                        </td>
                        <td title={m.mean_next_position ?? undefined}>
                          {fmtFixed(m.mean_next_position, 2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {subView === "matrix" && (
            <section className="ops-panel">
              <div className="panel-heading perf-filter-heading">
                <div>
                  <h2>Per-symbol × per-model backtest metrics</h2>
                  <p>
                    Exact selection return, annualized Sharpe, max drawdown,{" "}
                    {cycle.policy.confirmation_bars}-bar confirmation return,
                    and next-day target weight.
                  </p>
                </div>
                <div className="perf-filters">
                  <input
                    type="search"
                    aria-label="Filter by ticker symbol"
                    placeholder="Filter symbol…"
                    value={symbolFilter}
                    onChange={(e) => setSymbolFilter(e.target.value)}
                  />
                  <select
                    aria-label="Filter by sector"
                    value={sectorFilter}
                    onChange={(e) => setSectorFilter(e.target.value)}
                  >
                    <option value="all">All sectors</option>
                    <option value="stock">Stock</option>
                    <option value="bond">Bond</option>
                    <option value="crypto">Crypto</option>
                  </select>
                  <select
                    aria-label="Filter by model"
                    value={modelFilter}
                    onChange={(e) => setModelFilter(e.target.value)}
                  >
                    <option value="all">All models</option>
                    {cycle.model_summaries.map((m) => (
                      <option key={m.model_id} value={m.model_id}>
                        {m.model_id} — {m.label}
                      </option>
                    ))}
                  </select>
                  <label className="perf-check">
                    <input
                      type="checkbox"
                      checked={winnersOnly}
                      onChange={(e) => setWinnersOnly(e.target.checked)}
                    />
                    Winners only
                  </label>
                </div>
              </div>

              {filteredResults.length ? (
                <div
                  className="table-scroll"
                  tabIndex={0}
                  role="region"
                  aria-label="Symbol by model quant evaluation metrics table"
                >
                  <table>
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th>Sector</th>
                        <th>Model</th>
                        <th>Confirmation status</th>
                        <th>Selection return</th>
                        <th>Selection Sharpe</th>
                        <th>Selection max DD</th>
                        <th>Confirmation return</th>
                        <th>Next position</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredResults.map((row) => (
                        <tr key={`${row.symbol}-${row.model_id}`}>
                          <td>
                            <strong>{row.symbol}</strong>
                          </td>
                          <td>{row.sector}</td>
                          <td>
                            <code>{row.model_id}</code>{" "}
                            <span className="perf-dim">{row.model_label}</span>
                          </td>
                          <td>
                            <div className="perf-badges">
                              {row.is_stable_winner && (
                                <span className="perf-badge win">
                                  Stable winner
                                </span>
                              )}
                              {row.is_aggressive_winner && (
                                <span className="perf-badge aggr">
                                  Aggressive winner
                                </span>
                              )}
                              {row.model_id === "M00" && (
                                <span className="perf-badge neutral">
                                  Benchmark
                                </span>
                              )}
                              {!row.is_stable_winner &&
                                !row.is_aggressive_winner &&
                                row.model_id !== "M00" && (
                                  <span className="perf-dim">Evaluated</span>
                                )}
                            </div>
                          </td>
                          <td title={row.selection_net_return}>
                            <span
                              className={
                                Number(row.selection_net_return) > 0
                                  ? "perf-pos"
                                  : Number(row.selection_net_return) < 0
                                    ? "perf-neg"
                                    : ""
                              }
                            >
                              {fmtPct(row.selection_net_return)}
                            </span>
                          </td>
                          <td title={row.selection_sharpe ?? "Undefined"}>
                            {row.selection_sharpe === null
                              ? "Undefined (σ=0)"
                              : fmtFixed(row.selection_sharpe, 3)}
                          </td>
                          <td title={row.selection_max_drawdown}>
                            {fmtPct(row.selection_max_drawdown, false)}
                          </td>
                          <td title={row.confirmation_net_return}>
                            <span
                              className={
                                Number(row.confirmation_net_return) > 0
                                  ? "perf-pos"
                                  : "perf-neg"
                              }
                            >
                              {fmtPct(row.confirmation_net_return)}
                            </span>
                          </td>
                          <td title={row.next_position}>
                            <code>{fmtFixed(row.next_position, 2)}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="ops-empty">
                  <FileSpreadsheet size={26} />
                  <h3>No matching model evaluations</h3>
                  <p>
                    {cycle.model_results.length === 0
                      ? "No CPU worker node has uploaded model results for this evaluation cycle yet."
                      : "Adjust the symbol, sector, model, or winner filters to view stored evaluations."}
                  </p>
                </div>
              )}
            </section>
          )}

          {subView === "units" && (
            <div className="perf-stack">
              <section className="ops-panel">
                <div className="panel-heading">
                  <div>
                    <h2>Cycle work units &amp; screening figures</h2>
                    <p>
                      Per-symbol screening liquidity, daily bar count, worker
                      lease state, turnaround latency, and confirmed winners.
                    </p>
                  </div>
                </div>
                {cycle.work_units.length ? (
                  <div
                    className="table-scroll"
                    tabIndex={0}
                    role="region"
                    aria-label="Cycle work units table"
                  >
                    <table>
                      <thead>
                        <tr>
                          <th>Symbol</th>
                          <th>Sector</th>
                          <th>Unit status</th>
                          <th>Mean $ volume</th>
                          <th>Mean |move|</th>
                          <th>Bars</th>
                          <th>Stable winner</th>
                          <th>Aggressive winner</th>
                          <th>Worker node</th>
                          <th>Completed</th>
                          <th>Turnaround</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cycle.work_units.map((u) => (
                          <tr key={u.unit_id}>
                            <td>
                              <strong>{u.symbol}</strong>
                            </td>
                            <td>{u.sector}</td>
                            <td>
                              <span
                                className={`status ${u.status === "completed" ? "live" : "revoked"}`}
                              >
                                <span />
                                {u.status === "completed"
                                  ? "Completed"
                                  : u.status === "leased"
                                    ? "Leased"
                                    : u.status === "lease_expired"
                                      ? "Lease expired"
                                      : "Queued"}
                              </span>
                            </td>
                            <td title={u.mean_dollar_volume}>
                              {fmtDollarVol(u.mean_dollar_volume)}
                            </td>
                            <td title={u.mean_abs_move ?? undefined}>
                              {fmtPct(u.mean_abs_move, false)}
                            </td>
                            <td>{u.bar_count}</td>
                            <td>
                              {u.stable_winner ? (
                                <code>{u.stable_winner}</code>
                              ) : (
                                "None"
                              )}
                            </td>
                            <td>
                              {u.aggressive_winner ? (
                                <code>{u.aggressive_winner}</code>
                              ) : (
                                "None"
                              )}
                            </td>
                            <td>
                              {u.leased_to ? (
                                <code title={u.leased_to}>
                                  {u.leased_to.slice(0, 8)}…
                                </code>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td>{utcStamp(u.completed_at)}</td>
                            <td>
                              {u.turnaround_seconds !== null
                                ? `${u.turnaround_seconds.toFixed(1)}s`
                                : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="ops-empty">
                    <Clock size={26} />
                    <h3>No work units in this cycle</h3>
                  </div>
                )}
              </section>

              <section className="ops-panel">
                <div className="panel-heading">
                  <div>
                    <h2>CPU worker node throughput</h2>
                    <p>
                      Completed work units and active leases attributed by
                      worker credential ID.
                    </p>
                  </div>
                </div>
                {data?.worker_nodes.length ? (
                  <div
                    className="table-scroll"
                    tabIndex={0}
                    role="region"
                    aria-label="CPU worker node throughput table"
                  >
                    <table>
                      <thead>
                        <tr>
                          <th>Worker credential ID</th>
                          <th>Status</th>
                          <th>Active leases</th>
                          <th>Cycle units completed</th>
                          <th>All-time units completed</th>
                          <th>Last upload</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.worker_nodes.map((node) => (
                          <tr key={node.worker_id}>
                            <td>
                              <code>{node.worker_id}</code>
                            </td>
                            <td>
                              <span
                                className={`status ${node.revoked_at ? "revoked" : "live"}`}
                              >
                                <span />
                                {node.revoked_at ? "Revoked" : "Active"}
                              </span>
                            </td>
                            <td>{node.active_leases}</td>
                            <td>{node.completed_units_in_cycle}</td>
                            <td>{node.completed_units_total}</td>
                            <td>{utcStamp(node.last_completed_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="ops-empty">
                    <Cpu size={26} />
                    <h3>No worker nodes issued yet</h3>
                  </div>
                )}
              </section>
            </div>
          )}

          {subView === "events" && (
            <section className="ops-panel">
              <div className="panel-heading perf-filter-heading">
                <div>
                  <h2>Quant execution &amp; job event log</h2>
                  <p>
                    Chronological audit trail of cycle ingestion, unit claims,
                    uploaded evaluations, and validation rejections.
                  </p>
                </div>
                <div className="perf-filters">
                  <select
                    aria-label="Filter events by source"
                    value={eventSourceFilter}
                    onChange={(e) => setEventSourceFilter(e.target.value)}
                  >
                    <option value="all">All sources</option>
                    {eventSources.map((src) => (
                      <option key={src} value={src}>
                        {src}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {filteredEvents.length ? (
                <div
                  className="table-scroll"
                  tabIndex={0}
                  role="region"
                  aria-label="Quant event log table"
                >
                  <table>
                    <thead>
                      <tr>
                        <th>Timestamp</th>
                        <th>Source</th>
                        <th>Event</th>
                        <th>Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredEvents.map((ev) => (
                        <tr key={ev.id}>
                          <td>{utcStamp(ev.occurred_at)}</td>
                          <td>
                            <code>{ev.source}</code>
                          </td>
                          <td>
                            <span
                              className={`perf-badge ${
                                ev.event.includes("completed") ||
                                ev.event.includes("succeeded") ||
                                ev.event.includes("published")
                                  ? "win"
                                  : ev.event.includes("rejected") ||
                                      ev.event.includes("failed")
                                    ? "err"
                                    : "neutral"
                              }`}
                            >
                              {ev.event.includes("completed") && (
                                <CheckCircle2 size={11} />
                              )}
                              {ev.event}
                            </span>
                          </td>
                          <td>{summarizeEventDetail(ev.detail)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="ops-empty">
                  <Activity size={26} />
                  <h3>No events recorded for this filter</h3>
                </div>
              )}
            </section>
          )}
        </>
      )}
        </>
      )}

      <p className="ops-note">
        <ShieldCheck size={15} />
        All metrics are scoped strictly to pinned evaluation cycles (
        <code>cycle_id</code>) with verified bars, model-set version, policy,
        and sector trade costs—never mixed across unverified runs.
      </p>
    </div>
  );
}
