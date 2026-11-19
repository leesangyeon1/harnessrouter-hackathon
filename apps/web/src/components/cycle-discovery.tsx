"use client";

import { useEffect, useState } from "react";
import { CircleAlert, Compass, LoaderCircle, RefreshCw } from "lucide-react";
import { categoryName } from "@/lib/api";
import { coverageLabels, sectorIds, type LatestCycle } from "@/lib/cycles";
import "./cycle-discovery.css";

type Loader = () => Promise<LatestCycle | null>;
const labels = { stock: "Stocks", bond: "Bond ETFs", crypto: "Crypto" };

export function CycleDiscovery({
  load,
  sector,
}: {
  load: Loader;
  sector: string;
}) {
  const [request, setRequest] = useState(0);
  const [snapshot, setSnapshot] = useState<{
    cycle: LatestCycle | null;
    error: string | null;
    request: number;
    loader: Loader | null;
  }>({ cycle: null, error: null, request: -1, loader: null });
  const current = snapshot.request === request && snapshot.loader === load;
  const loading = !current;
  const error = current ? snapshot.error : null;
  const cycle = snapshot.cycle;
  useEffect(() => {
    let active = true;
    void load().then(
      (result) => {
        if (active)
          setSnapshot({ cycle: result, error: null, request, loader: load });
      },
      (caught) => {
        if (active)
          setSnapshot((previous) => ({
            ...previous,
            error:
              caught instanceof Error
                ? caught.message
                : "The cycle could not be loaded. Try again.",
            request,
            loader: load,
          }));
      },
    );
    return () => {
      active = false;
    };
  }, [load, request]);
  const retry = () => setRequest((value) => value + 1);

  return (
    <div className="cycle-discovery" aria-busy={loading}>
      <section className="panel cycle-summary">
        <div>
          <span className="eyebrow">PUBLISHED SECTOR SCREEN</span>
          <h2>
            {cycle ? `Cycle ${cycle.cycle_date}` : "Your next market view"}
          </h2>
          <p className="small muted">
            A qualified screen within the universe and feed shown for each
            sector.
          </p>
        </div>
        <button className="button secondary" disabled={loading} onClick={retry}>
          <RefreshCw size={15} className={loading ? "spin" : undefined} />
          Refresh cycle
        </button>
        {cycle && (
          <div className="cycle-versions">
            <span>
              Model set <strong>{cycle.model_set_version}</strong>
            </span>
            <span>
              Policy version <strong>{cycle.policy_version}</strong>
            </span>
            <span>
              {error || loading
                ? "Last retrieved cycle"
                : "Stored cycle inputs"}
            </span>
          </div>
        )}
      </section>
      {loading && (
        <div className="loading-banner" role="status">
          <LoaderCircle size={16} className="spin" />
          Loading the latest published cycle…
        </div>
      )}
      {error && (
        <div className="error-banner" role="alert">
          <CircleAlert size={16} />
          <span>
            {error}
            {cycle ? " The last retrieved screen remains below." : ""}
          </span>
          <button onClick={retry}>Try again</button>
        </div>
      )}
      {!cycle && !loading && !error && (
        <section className="panel">
          <div className="empty-state">
            <span className="empty-icon">
              <Compass size={24} />
            </span>
            <h3>No published cycle yet</h3>
            <p>
              Your service has not published a market screen. Refresh when a
              cycle becomes available.
            </p>
          </div>
        </section>
      )}
      {cycle &&
        sectorIds
          .filter((id) => sector === "all" || id === sector)
          .map((id) => {
            const screen = cycle.sectors[id];
            return (
              <section
                className="panel cycle-sector"
                key={id}
                aria-label={`${labels[id]} cycle screen`}
              >
                <div className="card-heading">
                  <h2>{labels[id]}</h2>
                  <span className="pill neutral-pill">
                    {screen
                      ? `${screen.selections.length} ${screen.selections.length === 1 ? "selection" : "selections"}`
                      : "Data not supplied"}
                  </span>
                </div>
                <dl className="cycle-source">
                  <div>
                    <dt>Universe</dt>
                    <dd>{screen?.universe ?? "Unavailable"}</dd>
                  </div>
                  <div>
                    <dt>Feed</dt>
                    <dd>{screen?.feed ?? "Unavailable"}</dd>
                  </div>
                </dl>
                {!screen ? (
                  <p className="cycle-missing">
                    This sector was not supplied for this cycle. Its coverage
                    and selections are unknown.
                  </p>
                ) : (
                  <>
                    <div className="cycle-coverage">
                      <h3>Coverage</h3>
                      <dl>
                        {[
                          ...new Set([
                            ...Object.keys(coverageLabels),
                            ...Object.keys(screen.coverage),
                          ]),
                        ].map((key) => (
                          <div key={key}>
                            <dt>{coverageLabels[key] ?? categoryName(key)}</dt>
                            <dd>
                              {screen.coverage[key] === undefined
                                ? "Unavailable"
                                : screen.coverage[key].toLocaleString("en-US")}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                    {screen.selections.length ? (
                      <div
                        className="table-scroll"
                        tabIndex={0}
                        role="region"
                        aria-label={`${labels[id]} selections`}
                      >
                        <table>
                          <thead>
                            <tr>
                              <th>Selected ticker</th>
                              <th>Mean dollar volume (USD)</th>
                              <th>Mean absolute move (ratio)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {screen.selections.map((row) => (
                              <tr key={row.symbol}>
                                <td>
                                  <strong>{row.symbol}</strong>
                                </td>
                                <td>
                                  <code>{row.mean_dollar_volume}</code>
                                </td>
                                <td>
                                  <code>{row.mean_abs_move}</code>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p className="cycle-missing">
                        No selections for this sector. The published coverage
                        above still applies.
                      </p>
                    )}
                    <p className="cycle-measures">
                      Figures retain the stored decimal precision. Mean absolute
                      move is a ratio (0.06 means 6%), not a signed daily
                      return. Rows retain the published order; this is not a
                      model-performance ranking.
                    </p>
                    <details className="cycle-exclusions">
                      <summary>
                        Named exclusions ({Object.keys(screen.excluded).length})
                      </summary>
                      {Object.keys(screen.excluded).length ? (
                        <dl>
                          {Object.entries(screen.excluded).map(
                            ([symbol, reason]) => (
                              <div key={symbol}>
                                <dt>{symbol}</dt>
                                <dd>{categoryName(reason)}</dd>
                              </div>
                            ),
                          )}
                        </dl>
                      ) : (
                        <p>
                          No named exclusions were supplied for this sector.
                        </p>
                      )}
                    </details>
                  </>
                )}
              </section>
            );
          })}
    </div>
  );
}
