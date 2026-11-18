# Deterministic finance core

Python 3.11+ package for the reviewed Finance Platform plan, with no runtime
dependencies or network clients. All figures are computed from supplied records.
This package never submits orders or reads credentials.

From the repository root:

```sh
python3 -m pip install -e packages/finance-core
PYTHONPATH=packages/finance-core/src python3 -m unittest discover -s packages/finance-core/tests -v
uvx ruff check packages/finance-core
uvx ruff format --check packages/finance-core
cd packages/finance-core
uvx mypy --config-file pyproject.toml
uv build
```

## Integration contracts

- `quant.Bar(date, open, high, low, close, volume)` accepts ascending unique
  ISO dates and finite, positive, consistent OHLC prices. Feed split-adjusted
  daily bars through the preceding cycle day. Filter crypto to the same broker
  equity-calendar dates before quant evaluation.
- `quant.evaluate(bars, sector="stock", policy_version=1)` requires 250 bars,
  takes the last 500, and returns eleven `ModelResult` dataclasses: M00 baseline
  plus ten strategies. Each carries model-set version `daily-v1`, policy version,
  canonical SHA-256 of its bars, selection and confirmation metrics, and the next
  day's position. The first 61 bars warm state; measurement starts at bar 62.
  The last 60 daily returns confirm the winner; earlier measured returns rank it.
- `quant.select_winner(results, "stable" | "aggressive")` excludes M00, applies
  policy v1's ranking and drawdown rule, breaks ties by model ID, and returns
  `None` when the top-ranked model fails positive confirmation. It refuses mixed
  bars/versions. The worker API must additionally require every registered model
  exactly once under the current lease; a selector may operate on an eligible
  subset to support unit tests and diagnostics.
- `screening.screen(assets, histories, sector, feed="iex", cycle_dates=...,
  as_of=...)` uses volume first, then absolute movement. `cycle_dates` is required
  for crypto. `as_of` is the preceding cycle date; pass it in production so stale
  histories are excluded. `ScreenResult` carries universe, observed feed,
  coverage, exclusions, every ranked figure, at most three selections, and each
  selection's last 500 bars. Equities include equity ETFs, bonds use the dated
  seven-ETF list, and crypto includes only Alpaca USD pairs. None is market-wide.
- `reports.spending`, `reports.card_report`, and `reports.refinance` accept
  normalized Sandbox records. Amounts use `Decimal`; positive Plaid transaction
  amounts are outflows, negative amounts are refunds/inflows, and pending entries
  are excluded. Purchase APR absence is `None`, never zero. Rewards and reference
  rates must come from owned, dated tables. Refinance reports use a fixed-rate,
  fully amortizing monthly schedule and exclude closing fees. `readable_types`
  must contain only loan types the U0 probe actually proved readable. Report
  schemas contain own labels and computed figures, no provider identifiers.
- `sizing.wanted_values` returns row-1 wanted values; `sell_targets` fits them
  around frozen holdings before sells. `targets` computes post-buy values from
  **fresh holdings after sells**, counting every holding against the budget.
  `existing_winners` is a subset of that total. Differences are buy amounts;
  the executor must omit amounts under $1. These functions implement proposed
  policy v1 only, with Decimal amounts rounded down to cents.

Use `dataclasses.asdict` for dataclass serialization. Serialize Decimal values as
decimal strings at HTTP/storage boundaries. Simulated return metrics must stay
labelled simulated, separate from broker-observed fills and performance.

## Evidence and remaining gate

The tests cover prior-bar-only signals, warmup state, hand-calculated entry/exit
signals, next-open fills, per-side costs, fractional rebalancing, both selectors,
confirmation rejection, pinned identity refusal, screening scope and coverage,
report arithmetic and unknown APRs, and sizing with frozen or rejected sells.

This is the pure calculation part of U3/U5/U6/U7. It does not satisfy the entire
reviewed final gate. U0's Plaid, Alpaca, HarnessRouter and owner-node probes are
unrun here. Provider ingestion, database isolation, worker leases and result
validation, broker reconciliation, tool calls, deployment and U8 require separate
integration evidence. No provider-filled order, external tool call, owner CPU-node
run, market-wide coverage, or advisor network isolation is claimed by these tests.
