export const sectorIds = ["stock", "bond", "crypto"] as const;
export type SectorId = (typeof sectorIds)[number];
export type CycleSelection = {
  symbol: string;
  mean_dollar_volume: string;
  mean_abs_move: string;
};
export type SectorScreen = {
  universe: string;
  feed: string;
  coverage: Record<string, number>;
  excluded: Record<string, string>;
  selections: CycleSelection[];
};
export type LatestCycle = {
  cycle_date: string;
  model_set_version: string;
  policy_version: number;
  sectors: Partial<Record<SectorId, SectorScreen>>;
};
export const coverageLabels: Record<string, string> = {
  provider_listed: "Provider listed",
  not_active: "Not active",
  not_tradable: "Not tradable",
  not_fractionable: "Not fractionable",
  not_on_list: "Not on list",
  not_usd: "Not USD",
  too_few_bars: "Too few bars",
  missing_screen_date: "Missing screen date",
  eligible: "Eligible",
  liquidity_ranked: "Liquidity ranked",
  selected: "Selected",
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const decimal = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\+?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) &&
  Number.isFinite(Number(value)) &&
  Number(value) >= 0;
const invalid = (): never => {
  throw new Error(
    "The published cycle response could not be read. Please try again.",
  );
};

// Retain decimal strings and the producer's order; do not re-rank rounded values.
// An omitted sector or coverage count stays unknown, distinct from zero.
export function parseCycle(value: unknown): LatestCycle {
  if (
    !record(value) ||
    !text(value.cycle_date) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.cycle_date)
  )
    return invalid();
  const date = new Date(`${value.cycle_date}T00:00:00Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value.cycle_date ||
    !text(value.model_set_version) ||
    !Number.isSafeInteger(value.policy_version) ||
    (value.policy_version as number) < 1 ||
    !record(value.sectors)
  )
    return invalid();
  if (
    Object.keys(value.sectors).some(
      (key) => !sectorIds.includes(key as SectorId),
    )
  )
    return invalid();
  const sectors: LatestCycle["sectors"] = {};
  for (const sector of sectorIds) {
    const screen = value.sectors[sector];
    if (screen === undefined) continue;
    if (
      !record(screen) ||
      !text(screen.universe) ||
      !text(screen.feed) ||
      !record(screen.coverage) ||
      !Object.values(screen.coverage).every(
        (n) => Number.isSafeInteger(n) && (n as number) >= 0,
      ) ||
      !record(screen.excluded) ||
      !Object.values(screen.excluded).every(text) ||
      !Array.isArray(screen.selections)
    )
      return invalid();
    const symbols = new Set<string>();
    const selections = screen.selections.map((row: unknown) => {
      if (
        !record(row) ||
        !text(row.symbol) ||
        symbols.has(row.symbol) ||
        !decimal(row.mean_dollar_volume) ||
        !decimal(row.mean_abs_move)
      )
        return invalid();
      symbols.add(row.symbol);
      return {
        symbol: row.symbol,
        mean_dollar_volume: row.mean_dollar_volume,
        mean_abs_move: row.mean_abs_move,
      };
    });
    sectors[sector] = {
      universe: screen.universe,
      feed: screen.feed,
      coverage: screen.coverage as Record<string, number>,
      excluded: screen.excluded as Record<string, string>,
      selections,
    };
  }
  return {
    cycle_date: value.cycle_date,
    model_set_version: value.model_set_version,
    policy_version: value.policy_version as number,
    sectors,
  };
}
