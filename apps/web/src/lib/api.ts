import { parseCycle, type LatestCycle } from "./cycles";
export type SpendingLine = { month: string; category: string; amount: string };
export type SpendingReport = {
  id: string;
  kind: "spending";
  computed_at: string;
  figures: SpendingLine[];
};
export type Me = { user_id: string; role: "user" | "admin" };
export type SyncCounts = {
  accounts: number;
  transactions: number;
  liabilities: number;
  holdings: number;
};

export function toCents(value: string): number {
  if (!/^-?\d+(\.\d{1,2})?$/.test(value))
    throw new Error("Invalid monetary value");
  const negative = value.startsWith("-");
  const [whole, decimal = ""] = value.replace("-", "").split(".");
  const cents = BigInt(whole) * 100n + BigInt(decimal.padEnd(2, "0"));
  const signed = negative ? -cents : cents;
  if (
    signed > BigInt(Number.MAX_SAFE_INTEGER) ||
    signed < BigInt(Number.MIN_SAFE_INTEGER)
  )
    throw new Error("Monetary value out of range");
  return Number(signed);
}

export function parseReport(data: unknown): SpendingReport {
  const value = data as Partial<SpendingReport> | null;
  if (
    !value ||
    typeof value.id !== "string" ||
    value.kind !== "spending" ||
    typeof value.computed_at !== "string" ||
    Number.isNaN(Date.parse(value.computed_at)) ||
    !Array.isArray(value.figures)
  )
    throw new ApiError(
      502,
      "The report response could not be read. Please try again.",
    );
  for (const line of value.figures) {
    if (
      !line ||
      typeof line.month !== "string" ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(line.month) ||
      typeof line.category !== "string" ||
      typeof line.amount !== "string"
    )
      throw new ApiError(
        502,
        "The report response could not be read. Please try again.",
      );
    toCents(line.amount);
  }
  return value as SpendingReport;
}

export function summarize(report: SpendingReport | null, month: string) {
  const groups = new Map<string, number>();
  for (const line of report?.figures ?? [])
    if (line.month === month)
      groups.set(
        line.category,
        (groups.get(line.category) ?? 0) + toCents(line.amount),
      );
  const categories = [...groups]
    .map(([name, amount]) => ({ name, amount }))
    .sort((a, b) => b.amount - a.amount);
  const total = categories.reduce((sum, row) => sum + row.amount, 0);
  if (!Number.isSafeInteger(total))
    throw new Error("Report total is out of range");
  return { total, categories };
}

export function apiOrigin(value: string): string {
  const url = new URL(value);
  const local =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !local) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "Set the API address to an HTTPS origin (or localhost for development).",
    );
  return url.origin;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public requestId?: string,
    public retryAfter?: string | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class FinanceApi {
  private origin: string;
  constructor(
    origin: string,
    private token: () => Promise<string>,
    private transport: typeof fetch = fetch,
  ) {
    this.origin = apiOrigin(origin);
  }
  private async request(path: string, method = "GET"): Promise<unknown> {
    const token = await this.token();
    if (!token) throw new ApiError(401, "Sign in to connect your workspace.");
    let response: Response;
    try {
      const send = this.transport;
      response = await send(`${this.origin}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new ApiError(
        0,
        "We couldn’t reach your finance service. Check your connection and try again.",
      );
    }
    if (!response.ok) {
      const messages: Record<number, string> = {
        401: "Your session expired. Please sign in again.",
        403: "Your account doesn’t have permission for this action.",
        404: "This information is not available yet.",
        409: "This workspace needs a Sandbox profile first, or already has one.",
        429: "A few too many requests. Please wait before trying again.",
        502: "The data provider is temporarily unavailable. Please try again.",
      };
      throw new ApiError(
        response.status,
        messages[response.status] ??
          "Something went wrong. Your existing data is still available; please try again.",
        response.headers.get("X-Request-ID") ?? undefined,
        response.headers.get("Retry-After"),
      );
    }
    if (response.status === 204) return undefined;
    try {
      return await response.json();
    } catch {
      throw new ApiError(
        502,
        "The service returned an unreadable response. Please try again.",
      );
    }
  }
  async me(): Promise<Me> {
    const data = (await this.request("/v1/me")) as Me;
    if (
      typeof data?.user_id !== "string" ||
      !["user", "admin"].includes(data.role)
    )
      throw new ApiError(502, "Your account response could not be read.");
    return data;
  }
  async spending(): Promise<SpendingReport | null> {
    try {
      return parseReport(await this.request("/v1/reports/spending"));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }
  async seed(): Promise<void> {
    await this.request("/v1/plaid/seed", "POST");
  }
  async sync(): Promise<SyncCounts> {
    const data = (await this.request("/v1/plaid/sync", "POST")) as SyncCounts;
    if (
      ![
        data?.accounts,
        data?.transactions,
        data?.liabilities,
        data?.holdings,
      ].every((n) => Number.isInteger(n) && n >= 0)
    )
      throw new ApiError(502, "The sync response could not be read.");
    return data;
  }
  async computeSpending(): Promise<SpendingReport> {
    return parseReport(await this.request("/v1/reports/spending", "POST"));
  }
  async latestCycle(): Promise<LatestCycle | null> {
    try {
      const data = await this.request("/v1/cycles/latest");
      try {
        return parseCycle(data);
      } catch {
        throw new ApiError(
          502,
          "The published cycle response could not be read. Please try again.",
        );
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }
}

export const money = (cents: number, compact = false) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: compact ? 0 : 2,
  }).format(cents / 100);
export const categoryName = (value: string) =>
  value
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
export const monthName = (value: string, short = false) =>
  new Date(`${value}-02T12:00:00`).toLocaleDateString("en-US", {
    month: short ? "short" : "long",
    year: short ? undefined : "numeric",
  });
