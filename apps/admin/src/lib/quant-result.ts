// Same nested/flat candidate shapes used by the customer quant-emulator.
// Rendering only: rankings and metrics are never recalculated here.
export type JsonRow = Record<string, unknown>;
export function row(value: unknown): JsonRow {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRow)
    : {};
}
export const reported = (value: unknown): string =>
  value === undefined
    ? "Unknown"
    : value === null
      ? "None (reported null)"
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
export function candidates(value: unknown) {
  const entries = Array.isArray(value)
    ? value.map((item) => [undefined, item] as const)
    : Object.entries(row(value));
  return entries.map(([key, value]) => {
    const candidate = row(value);
    const selection = candidate.selection
      ? row(candidate.selection)
      : {
          net_return:
            candidate.selection_net_return ?? candidate.selection_return,
          sharpe: candidate.selection_sharpe,
          max_drawdown:
            candidate.selection_max_drawdown ?? candidate.max_drawdown,
        };
    const confirmation = candidate.confirmation
      ? row(candidate.confirmation)
      : {
          net_return:
            candidate.confirmation_net_return ?? candidate.confirmation_return,
          sharpe: candidate.confirmation_sharpe,
          max_drawdown: candidate.confirmation_max_drawdown,
        };
    return {
      id: candidate.model_id ?? candidate.id ?? key,
      values: [
        selection.net_return,
        selection.sharpe,
        selection.max_drawdown,
        confirmation.net_return,
        confirmation.sharpe,
        confirmation.max_drawdown,
      ],
    };
  });
}
export function evaluations(value: unknown): JsonRow[] | null {
  const result = row(value);
  if (
    typeof result.status !== "string" ||
    !Array.isArray(result.evaluations) ||
    result.evaluations.some(
      (item) => !item || typeof item !== "object" || Array.isArray(item),
    )
  )
    return null;
  return result.evaluations as JsonRow[];
}
