import { parseCycle, type LatestCycle } from "./cycles";
import {
  parseAdvisorDbSnapshot,
  type AdvisorDbSelection,
  type AdvisorDbSnapshot,
} from "./advisor-db-context";
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
  transactions_ready: boolean;
  unavailable: Partial<Record<"liabilities" | "holdings", string>>;
};
export type AgentCitation = {
  URL?: string | null;
  url?: string | null;
  source_title?: string | null;
  title?: string | null;
  supported_facts?: string[];
};
export type VerifiedInstrument = {
  name: string | null;
  asset_type: string | null;
  symbol: string | null;
  exchange_or_venue: string | null;
  quote_currency: string | null;
  verification_status: string | null;
  quote: Record<string, unknown> | string | null;
  screening_evidence: Record<string, unknown> | string | null;
  citations: AgentCitation[];
};
export type StructuredSearchResult = {
  status:
    | "ok"
    | "partial"
    | "needs_clarification"
    | "unavailable"
    | "out_of_scope"
    | string;
  query: string | null;
  results: VerifiedInstrument[];
  limitations: string[];
  clarification: string | null;
};
export type AgentFeatureKey = "advisor" | "quant_eval" | "search";
export type QuantEvaluationItem = {
  cycle_id?: string | null;
  symbol?: string | null;
  pinned_identities?: Record<string, unknown> | null;
  baseline?: Record<string, unknown> | null;
  candidate_metrics?:
    Record<string, unknown>[] | Record<string, unknown> | null;
  stable_winner?: string | null;
  aggressive_winner?: string | null;
  reasons?: Record<string, unknown> | unknown[] | string | null;
};
export type QuantEvaluationResult = {
  status: string;
  simulation_label?: string | null;
  evaluations: QuantEvaluationItem[];
  issues?: unknown[];
};
export type QuantEvaluationBundle = {
  prompt: string;
  pinned_identities: {
    cycle_id: string;
    symbol: string;
    sector: string;
    data_origin: string;
    model_set_version: string;
    policy_version: number;
    policy_hash: string;
    costs_hash: string;
    cost_per_side: number;
    bars_count: number;
    bars_hash: string;
    confirmation_bars: number;
  };
  available_cycle_symbols: string[];
};
export type AgentTaskFile = {
  path: string;
  filename: string;
  bytes: number | null;
  media_type: string;
  download_path: string;
};
export type AgentTask = {
  id: string;
  feature_key?: AgentFeatureKey;
  status:
    | "starting"
    | "in_progress"
    | "completed"
    | "incomplete"
    | "failed"
    | "cancelled";
  incomplete_reason: string | null;
  query: string;
  parent_task_id: string | null;
  answer: string;
  structured_result: StructuredSearchResult | null;
  quant_result?: QuantEvaluationResult | null;
  files: AgentTaskFile[];
  preview_url: string | null;
  can_continue: boolean;
  created_at: string;
  updated_at: string;
};
export type AgentProgressEvent =
  | { kind: "activity"; label: string }
  | { kind: "text"; delta: string }
  | { kind: "done"; status: string };

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

type StoredGuestSession = {
  token: string;
  user_id: string;
  expires_at: number;
};

const GUEST_STORAGE_KEY = "harness_guest_session_v1";
let memoryGuestSession: StoredGuestSession | null = null;
let inflightGuestPromise: Promise<string> | null = null;

function readStoredGuestSession(): StoredGuestSession | null {
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(GUEST_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<StoredGuestSession>;
        if (
          typeof parsed.token === "string" &&
          typeof parsed.user_id === "string" &&
          typeof parsed.expires_at === "number"
        ) {
          return parsed as StoredGuestSession;
        }
      }
    } catch {
      /* fall back to in-memory session */
    }
  }
  return memoryGuestSession;
}

function writeStoredGuestSession(session: StoredGuestSession): void {
  memoryGuestSession = session;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify(session));
    } catch {
      /* keep in-memory session */
    }
  }
}

export async function fetchGuestToken(
  rawOrigin: string,
  transport: typeof fetch = fetch,
): Promise<string> {
  const origin = apiOrigin(rawOrigin);
  const existing = readStoredGuestSession();
  const nowSec = Math.floor(Date.now() / 1000);
  if (existing && existing.expires_at - nowSec > 300) {
    return existing.token;
  }
  if (inflightGuestPromise) return inflightGuestPromise;

  inflightGuestPromise = (async () => {
    try {
      const response = await transport(`${origin}/v1/auth/guest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          existing?.token ? { previous_token: existing.token } : {},
        ),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) {
        throw new ApiError(
          response.status,
          "Could not start an open guest workspace session.",
        );
      }
      const data = (await response.json()) as Partial<StoredGuestSession>;
      if (
        typeof data.token !== "string" ||
        typeof data.user_id !== "string" ||
        typeof data.expires_at !== "number"
      ) {
        throw new ApiError(502, "Guest session response could not be read.");
      }
      const session: StoredGuestSession = {
        token: data.token,
        user_id: data.user_id,
        expires_at: data.expires_at,
      };
      writeStoredGuestSession(session);
      return session.token;
    } finally {
      inflightGuestPromise = null;
    }
  })();

  return inflightGuestPromise;
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
  private async request(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<unknown> {
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
        body: body !== undefined ? JSON.stringify(body) : undefined,
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
      ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      typeof data.transactions_ready !== "boolean" ||
      !data.unavailable ||
      typeof data.unavailable !== "object" ||
      Array.isArray(data.unavailable) ||
      !Object.entries(data.unavailable).every(
        ([product, code]) =>
          ["liabilities", "holdings"].includes(product) &&
          typeof code === "string" &&
          code.trim().length > 0,
      )
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
  previewFullUrl(previewPath: string): string {
    return `${this.origin}${previewPath}`;
  }
  async getQuantBundle(
    symbol: string,
    mode: "auto" | "stored" | "sample" = "auto",
  ): Promise<QuantEvaluationBundle> {
    const qs = `symbol=${encodeURIComponent(symbol)}&mode=${encodeURIComponent(mode)}`;
    return (await this.request(
      `/v1/agent-tasks/quant-bundle?${qs}`,
    )) as QuantEvaluationBundle;
  }
  async startAgentTask(
    input: string,
    options?: {
      featureKey?: AgentFeatureKey;
      followUpTaskId?: string;
      advisorContext?: AdvisorDbSelection;
    },
  ): Promise<AgentTask> {
    const payload: Record<string, unknown> = { input };
    if (options?.featureKey) payload.feature_key = options.featureKey;
    if (options?.followUpTaskId)
      payload.follow_up_task_id = options.followUpTaskId;
    if (options?.advisorContext)
      payload.advisor_context = options.advisorContext;
    return (await this.request(
      "/v1/agent-tasks",
      "POST",
      payload,
    )) as AgentTask;
  }
  async advisorContext(scenarioId: string): Promise<AdvisorDbSnapshot> {
    try {
      return await parseAdvisorDbSnapshot(
        await this.request(
          `/v1/agent-tasks/advisor-context?scenario_id=${encodeURIComponent(scenarioId)}`,
        ),
        scenarioId,
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 404)
        throw new ApiError(
          404,
          "The stored synthetic scenario is unavailable. Its database seed may be missing; retry before analyzing.",
        );
      throw error;
    }
  }
  async listAgentTasks(featureKey?: AgentFeatureKey): Promise<AgentTask[]> {
    const suffix = featureKey
      ? `?feature_key=${encodeURIComponent(featureKey)}`
      : "";
    const data = (await this.request(`/v1/agent-tasks${suffix}`)) as {
      tasks?: AgentTask[];
    };
    return Array.isArray(data?.tasks) ? data.tasks : [];
  }
  async getAgentTask(taskId: string): Promise<AgentTask> {
    return (await this.request(
      `/v1/agent-tasks/${encodeURIComponent(taskId)}`,
    )) as AgentTask;
  }
  async cancelAgentTask(taskId: string): Promise<AgentTask> {
    return (await this.request(
      `/v1/agent-tasks/${encodeURIComponent(taskId)}/cancel`,
      "POST",
    )) as AgentTask;
  }
  async streamAgentTaskEvents(
    taskId: string,
    onEvent: (event: AgentProgressEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const token = await this.token();
    if (!token) throw new ApiError(401, "Sign in to connect your workspace.");
    const send = this.transport;
    const response = await send(
      `${this.origin}/v1/agent-tasks/${encodeURIComponent(taskId)}/events`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "text/event-stream",
        },
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal,
      },
    );
    if (!response.ok || !response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf = (buf + decoder.decode(value, { stream: true })).replace(
        /\r\n/g,
        "\n",
      );
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data) as AgentProgressEvent;
          onEvent(parsed);
          if (parsed.kind === "done") return;
        } catch {
          /* ignore malformed SSE frames */
        }
      }
    }
  }
  async downloadAgentTaskFile(
    downloadPath: string,
    filename: string,
  ): Promise<void> {
    const token = await this.token();
    if (!token) throw new ApiError(401, "Sign in to connect your workspace.");
    const send = this.transport;
    const response = await send(`${this.origin}${downloadPath}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok)
      throw new ApiError(
        response.status,
        "The file could not be downloaded. Please try again.",
      );
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
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
