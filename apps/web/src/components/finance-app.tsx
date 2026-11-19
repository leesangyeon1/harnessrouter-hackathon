"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import {
  onIdTokenChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  type User,
} from "firebase/auth";
import {
  ArrowDownLeft,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  CreditCard,
  ExternalLink,
  FlaskConical,
  Landmark,
  Leaf,
  Link2,
  LoaderCircle,
  LogOut,
  Menu,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Wallet,
  X,
  ChartNoAxesCombined,
  LayoutDashboard,
  Compass,
  Cpu,
  SlidersHorizontal,
  CircleAlert,
} from "lucide-react";
import {
  ApiError,
  FinanceApi,
  categoryName,
  fetchGuestToken,
  money,
  monthName,
  summarize,
  type Me,
  type SpendingReport,
  type SyncCounts,
} from "@/lib/api";
import {
  accounts,
  demoReport,
  market,
  palette,
  transactions,
} from "@/lib/demo";
import { authConfigured, identityAuth } from "@/lib/firebase";
import { CycleDiscovery } from "./cycle-discovery";
import { FinanceAdvisor } from "./finance-advisor";
import { QuantEmulator } from "./quant-emulator";
import { SyncNotice } from "./sync-notice";
import { TickerVerifier } from "./ticker-verifier";

type View =
  | "overview"
  | "advisor"
  | "spending"
  | "accounts"
  | "cards"
  | "investing"
  | "quant"
  | "discovery"
  | "verifier"
  | "settings";
type Dialog =
  "connect" | "auth" | "search" | "notifications" | "help" | "mode" | null;
const navigation: {
  id: View;
  label: string;
  icon: typeof Wallet;
  section?: string;
}[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "advisor", label: "Finance advisor", icon: Sparkles },
  { id: "spending", label: "Spending", icon: ChartNoAxesCombined },
  { id: "accounts", label: "Accounts", icon: Landmark },
  { id: "cards", label: "Cards & loans", icon: CreditCard },
  {
    id: "investing",
    label: "Paper investing",
    icon: TrendingUp,
    section: "GROW YOUR MONEY",
  },
  { id: "quant", label: "Quant emulator", icon: Cpu },
  { id: "discovery", label: "Market discovery", icon: Compass },
  { id: "verifier", label: "Ticker verifier", icon: Sparkles },
];
const titles: Record<View, string> = {
  overview: "Your money, in view.",
  advisor: "Compare with confidence.",
  spending: "Know where it goes.",
  accounts: "All together, at last.",
  cards: "A clearer picture of credit.",
  investing: "A little room to explore.",
  quant: "Test every signal cleanly.",
  discovery: "Look a little closer.",
  verifier: "Verify before you move.",
  settings: "Make yourself at home.",
};

function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide" : ""}`}
      aria-labelledby="dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-heading">
        <h2 id="dialog-title">{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

function Empty({
  icon: Icon = Wallet,
  title,
  text,
  action,
}: {
  icon?: typeof Wallet;
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon size={26} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}

function Donut({
  categories,
  total,
}: {
  categories: { name: string; amount: number }[];
  total: number;
}) {
  const positive = categories.filter((c) => c.amount > 0);
  const base = positive.reduce((sum, c) => sum + c.amount, 0) || 1;
  return (
    <div className="donut-wrap">
      <svg
        viewBox="0 0 200 200"
        role="img"
        aria-label={`Spending by category, ${money(total)} total`}
      >
        <circle
          cx="100"
          cy="100"
          r="79"
          fill="none"
          stroke="#f0f0ed"
          strokeWidth="18"
        />
        {positive.map((category, index) => {
          const length = (category.amount / base) * 496.37;
          const start = positive
            .slice(0, index)
            .reduce((sum, row) => sum + (row.amount / base) * 496.37, 0);
          return (
            <circle
              key={category.name}
              cx="100"
              cy="100"
              r="79"
              fill="none"
              stroke={palette[index % palette.length]}
              strokeWidth="18"
              strokeDasharray={`${Math.max(0, length - 4)} ${496.37 - Math.max(0, length - 4)}`}
              strokeDashoffset={-start}
              transform="rotate(-90 100 100)"
              strokeLinecap="round"
            >
              <title>{`${categoryName(category.name)}: ${money(category.amount)}`}</title>
            </circle>
          );
        })}
      </svg>
      <div className="donut-label">
        <span>Total spent</span>
        <strong>{money(total)}</strong>
        <small>this month</small>
      </div>
    </div>
  );
}

function NetWorthChart() {
  return (
    <div className="net-chart">
      <div className="chart-axis">
        <span>$45k</span>
        <span>$40k</span>
        <span>$35k</span>
      </div>
      <svg
        viewBox="0 0 660 164"
        role="img"
        aria-label="Sample net worth increases from $36,080 in May to $42,850 in November"
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="worth-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#ed705b" stopOpacity=".17" />
            <stop offset="100%" stopColor="#ed705b" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path
          d="M0 24H660M0 82H660M0 140H660"
          stroke="#eeefeb"
          strokeDasharray="4 5"
          fill="none"
        />
        <path
          d="M0 135C25 134 35 114 60 119S95 109 120 113S156 88 185 93S210 103 235 83S268 96 295 76S332 82 354 62S386 72 408 57S446 67 467 47S500 60 525 44S555 49 584 31S622 43 655 20V164H0Z"
          fill="url(#worth-fill)"
        />
        <path
          d="M0 135C25 134 35 114 60 119S95 109 120 113S156 88 185 93S210 103 235 83S268 96 295 76S332 82 354 62S386 72 408 57S446 67 467 47S500 60 525 44S555 49 584 31S622 43 655 20"
          fill="none"
          stroke="#e66a54"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <circle
          cx="655"
          cy="20"
          r="5"
          fill="#e66a54"
          stroke="white"
          strokeWidth="3"
        />
      </svg>
      <div className="chart-months">
        {["May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov"].map((m) => (
          <span key={m}>{m}</span>
        ))}
      </div>
    </div>
  );
}

export function FinanceApp() {
  const [view, setView] = useState<View>("overview");
  const [mobileNav, setMobileNav] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [demo, setDemo] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [report, setReport] = useState<SpendingReport | null>(null);
  const [month, setMonth] = useState("2026-11");
  const [counts, setCounts] = useState<SyncCounts | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [query, setQuery] = useState("");
  const [sector, setSector] = useState("all");
  const [liveDiscovery, setLiveDiscovery] = useState(false);
  const [mode, setMode] = useState<"stable" | "aggressive">("stable");
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const sequence = useRef(0);
  const identity = useRef<string | null | undefined>(undefined);
  const transactionsPreparing = !demo && counts?.transactions_ready === false;
  const readyEmptyReport =
    !demo &&
    counts?.transactions_ready === true &&
    report !== null &&
    report.figures.length === 0;
  const visibleReport = demo
    ? demoReport
    : transactionsPreparing
      ? null
      : report;
  const summary = summarize(visibleReport, month);
  const [year, monthNumber] = month.split("-").map(Number);
  const priorMonth = `${monthNumber === 1 ? year - 1 : year}-${String(monthNumber === 1 ? 12 : monthNumber - 1).padStart(2, "0")}`;
  const priorTotal = summarize(visibleReport, priorMonth).total;
  const monthlyChange =
    priorTotal > 0 ? ((summary.total - priorTotal) / priorTotal) * 100 : null;
  const availableMonths = [
    ...new Set(
      visibleReport?.figures.map((row) => row.month) ?? [
        new Date().toISOString().slice(0, 7),
      ],
    ),
  ]
    .sort()
    .reverse();
  const firstName = demo
    ? "Alex"
    : user?.displayName?.split(" ")[0] || user?.email?.split("@")[0] || "there";

  const client = useCallback(
    (account: User) =>
      new FinanceApi(process.env.NEXT_PUBLIC_API_BASE_URL ?? "", () =>
        account.getIdToken(),
      ),
    [],
  );
  const guestClient = useCallback(() => {
    const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
    if (!base) return null;
    try {
      return new FinanceApi(base, () => fetchGuestToken(base));
    } catch {
      return null;
    }
  }, []);
  const refresh = useCallback(
    async (account: User) => {
      const current = ++sequence.current;
      setLoading(true);
      setError(null);
      try {
        const api = client(account);
        const [profile, spending] = await Promise.all([
          api.me(),
          api.spending(),
        ]);
        if (sequence.current !== current) return;
        setMe(profile);
        setReport(spending);
        const latest = spending?.figures
          .map((row) => row.month)
          .sort()
          .at(-1);
        if (latest) setMonth(latest);
      } catch (caught) {
        if (sequence.current === current)
          setError(
            caught instanceof Error
              ? caught.message
              : "Your workspace could not be loaded.",
          );
      } finally {
        if (sequence.current === current) setLoading(false);
      }
    },
    [client],
  );
  const verifierApi = useMemo(
    () => (user ? client(user) : guestClient()),
    [client, guestClient, user],
  );
  const loadCycle = useCallback(
    async () => (verifierApi ? verifierApi.latestCycle() : null),
    [verifierApi],
  );

  useEffect(() => {
    if (!authConfigured()) return;
    let unsubscribe: (() => void) | undefined;
    let active = true;
    void identityAuth()
      .then((auth) => {
        if (!active) return;
        unsubscribe = onIdTokenChanged(auth, (account) => {
          if (!active) return;
          setUser(account);
          const nextIdentity = account?.uid ?? null;
          if (identity.current === nextIdentity) return;
          identity.current = nextIdentity;
          sequence.current++;
          setReport(null);
          setMe(null);
          setCounts(null);
          setBusy(false);
          if (account) {
            setDemo(false);
            void refresh(account);
          } else {
            setDemo(true);
            setLoading(false);
          }
        });
      })
      .catch(() => {
        /* Preview remains usable when Identity Platform is unavailable. */
      });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [refresh]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setDialog("search");
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 6500);
    return () => clearTimeout(timer);
  }, [toast]);

  function go(next: View) {
    setView(next);
    setMobileNav(false);
    setDialog(null);
    setQuery("");
    requestAnimationFrame(() => {
      document.getElementById("main-content")?.focus({ preventScroll: true });
      window.scrollTo({ top: 0 });
    });
  }
  function connect() {
    setError(null);
    setDialog("connect");
  }
  async function connectSandbox() {
    if (!verifierApi) {
      setDialog("auth");
      return;
    }
    const current = sequence.current;
    setBusy(true);
    setError(null);
    try {
      const api = verifierApi;
      try {
        await api.seed();
      } catch (caught) {
        if (!(caught instanceof ApiError && caught.status === 409))
          throw caught;
      }
      if (sequence.current !== current) return;
      const synced = await api.sync();
      if (sequence.current !== current) return;
      setCounts(synced);
      setDemo(false);
      if (!synced.transactions_ready) {
        setDialog(null);
        setToast(
          "Sandbox connected. Plaid is still preparing your transactions; retry sync to check again.",
        );
        return;
      }
      const computed = await api.computeSpending();
      if (sequence.current !== current) return;
      setReport(computed);
      const latest = computed.figures
        .map((row) => row.month)
        .sort()
        .at(-1);
      if (latest) setMonth(latest);
      setDialog(null);
      setToast(
        `Sandbox connected. ${synced.accounts} accounts and ${synced.transactions} transactions synced.`,
      );
    } catch (caught) {
      if (sequence.current === current)
        setError(
          caught instanceof Error
            ? caught.message
            : "The Sandbox could not be connected.",
        );
    } finally {
      if (sequence.current === current) setBusy(false);
    }
  }
  async function sync() {
    if (demo || !verifierApi) {
      connect();
      return;
    }
    const current = sequence.current;
    setBusy(true);
    setError(null);
    try {
      const api = verifierApi;
      const synced = await api.sync();
      if (sequence.current !== current) return;
      setCounts(synced);
      if (!synced.transactions_ready) {
        setToast(
          "Plaid is still preparing transactions. No spending report was calculated; you can retry sync.",
        );
        return;
      }
      const result = await api.computeSpending();
      if (sequence.current !== current) return;
      setReport(result);
      const latest = result.figures
        .map((row) => row.month)
        .sort()
        .at(-1);
      if (latest && (!report || transactionsPreparing)) setMonth(latest);
      setToast(
        Object.keys(synced.unavailable).length
          ? "Spending report updated. Some products are not available from Plaid."
          : "Your Sandbox data and spending report are up to date.",
      );
    } catch (caught) {
      if (sequence.current === current)
        setError(
          caught instanceof Error
            ? caught.message
            : "Sync could not be completed.",
        );
    } finally {
      if (sequence.current === current) setBusy(false);
    }
  }
  async function logout() {
    if (user) await signOut(await identityAuth());
    sequence.current++;
    setUser(null);
    setMe(null);
    setReport(null);
    setCounts(null);
    setBusy(false);
    setLoading(false);
    setDemo(true);
    setMonth("2026-11");
    setError(null);
    setToast("Signed out. You’re now viewing the sample workspace.");
  }
  function exportReport() {
    if (!visibleReport) return;
    const cell = (value: string) =>
      `"${(/^[=+\-@]/.test(value) ? "'" : "") + value.replaceAll('"', '""')}"`;
    const data = [
      "Month,Category,Amount (USD)",
      ...visibleReport.figures
        .filter((row) => row.month === month)
        .map((row) =>
          [cell(row.month), cell(categoryName(row.category)), row.amount].join(
            ",",
          ),
        ),
    ].join("\r\n");
    const url = URL.createObjectURL(
      new Blob([data], { type: "text/csv;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `harness-${demo ? "sample-" : ""}spending-${month}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    setToast("Your spending report has been downloaded.");
  }

  const action = (
    <button className="button primary" onClick={connect}>
      <Plus size={17} />
      Connect account
    </button>
  );
  const sectionHeader = (label: string, next?: View, link = "View all") => (
    <div className="card-heading">
      <h2>{label}</h2>
      {next ? (
        <button className="text-button" onClick={() => go(next)}>
          {link}
          <ChevronRight size={15} />
        </button>
      ) : null}
    </div>
  );
  const accountRows = (
    <div className="account-list">
      {accounts.map((account) => (
        <button
          className="account-row"
          key={account.name}
          onClick={() =>
            go(account.type === "Paper investment" ? "investing" : "accounts")
          }
        >
          <span className="bank-logo" style={{ background: account.color }}>
            {account.short}
          </span>
          <span className="row-text">
            <strong>{account.name}</strong>
            <span>
              {account.bank} ·{" "}
              {account.last ? `••${account.last}` : "Paper account"}
            </span>
          </span>
          <span className="row-amount">
            {money(account.balance)}
            <ChevronRight size={14} />
          </span>
        </button>
      ))}
    </div>
  );

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      {mobileNav && (
        <button
          className="nav-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside
        className={`sidebar ${mobileNav ? "is-open" : ""}`}
        aria-label="Main navigation"
      >
        <Link
          className="brand"
          href="/"
          onClick={() => go("overview")}
          aria-label="Harness overview"
        >
          <svg className="brand-symbol" viewBox="0 0 38 38" aria-hidden="true">
            <rect width="38" height="38" rx="12" fill="currentColor" />
            <path
              d="M12 9v20m14-20v20M12 20c5-6 10-6 14-1"
              fill="none"
              stroke="white"
              strokeWidth="4"
              strokeLinecap="round"
            />
          </svg>
          <span>
            harness<span className="brand-dot">.</span>
          </span>
        </Link>
        <div className="workspace-tag">
          <span className="tiny-dot" />
          Personal workspace
          <ChevronDown size={13} />
        </div>
        <nav>
          {navigation.map((item) => (
            <div key={item.id}>
              {item.section && <p className="nav-section">{item.section}</p>}
              <button
                className={`nav-item ${view === item.id ? "active" : ""}`}
                onClick={() => go(item.id)}
                aria-current={view === item.id ? "page" : undefined}
              >
                <item.icon size={19} />
                <span>{item.label}</span>
                {view === item.id && <span className="nav-active-dot" />}
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span className="note-icon">
              <Leaf size={20} />
            </span>
            <strong>Small steps. Bigger picture.</strong>
            <p>A little clarity goes a long way.</p>
            <button onClick={() => go("spending")}>
              See your spending
              <ArrowRight size={14} />
            </button>
          </div>
          <button
            className={`nav-item ${view === "settings" ? "active" : ""}`}
            onClick={() => go("settings")}
          >
            <Settings2 size={18} />
            Settings
          </button>
          <button className="nav-item" onClick={() => setDialog("help")}>
            <CircleHelp size={18} />
            Help & support
          </button>
          <div className="sandbox-label">
            <ShieldCheck size={14} />
            Sandbox & paper only
          </div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              aria-expanded={mobileNav}
              onClick={() => setMobileNav(true)}
            >
              <Menu size={22} />
            </button>
            <div className="breadcrumb">
              Your workspace<span>/</span>
              <strong>
                {navigation.find((item) => item.id === view)?.label ??
                  "Settings"}
              </strong>
            </div>
          </div>
          <div className="topbar-right">
            <button
              className="search-trigger"
              onClick={() => setDialog("search")}
            >
              <Search size={17} />
              <span>Find something</span>
              <kbd>⌘ K</kbd>
            </button>
            <span className={`workspace-badge ${demo ? "demo" : ""}`}>
              <span className="tiny-dot" />
              {demo ? "Sample data" : "Sandbox"}
            </span>
            <button
              className="icon-button notification"
              aria-label="Notifications"
              onClick={() => setDialog("notifications")}
            >
              <Bell size={19} />
              <span />
            </button>
            <button
              className="avatar"
              onClick={() => go("settings")}
              aria-label="Open profile settings"
            >
              {demo ? "AL" : (user?.email?.slice(0, 2).toUpperCase() ?? "YO")}
            </button>
          </div>
        </header>
        <main id="main-content" className="main-content" tabIndex={-1}>
          <div className="page-heading">
            <div>
              <p className="greeting">
                Good to see you, {firstName}
                <span className="greeting-sun">✳</span>
              </p>
              <h1>{titles[view]}</h1>
              <p className="page-subtitle">
                {view === "overview"
                  ? "Compare cards, debt payoff, and refinancing right alongside your balances."
                  : view === "advisor"
                    ? "Evaluate credit-card paydown, balance transfers, and loan refinancing with verified numbers."
                    : view === "spending"
                    ? "The little things add up. See the whole picture."
                    : view === "accounts"
                      ? "Your accounts, with a little less back and forth."
                      : view === "cards"
                        ? "Understand your balances, payments, and possibilities."
                        : view === "investing"
                          ? "Explore quantitative strategies with paper money."
                          : view === "quant"
                            ? "Run daily-v1 strategy models (M01–M08, M10, M11 vs. M00) in an isolated CPU sandbox."
                            : view === "discovery"
                            ? "A focused view of stocks, bond ETFs, and crypto."
                            : view === "verifier"
                              ? "Identify and verify listed securities, bond ETFs, and crypto USD pairs from public sources."
                              : "Your profile, connections, and workspace preferences."}
              </p>
            </div>
            <div className="heading-actions">
              {view === "discovery" ||
              view === "verifier" ||
              view === "advisor" ||
              view === "quant" ? (
                !verifierApi && demo ? (
                  <button
                    className="button primary"
                    key="cycle-signin"
                    onClick={() => setDialog("auth")}
                  >
                    {view === "verifier"
                      ? "Sign in to verify"
                      : view === "advisor"
                        ? "Sign in to analyze"
                        : view === "quant"
                          ? "Sign in to run emulator"
                          : "Sign in for latest cycle"}
                    <ArrowRight size={15} />
                  </button>
                ) : (
                  <span className="pill neutral-pill">
                    {view === "verifier"
                      ? "Open access · Public lookup"
                      : view === "advisor"
                        ? "Open access · Per-visitor memory"
                        : view === "quant"
                          ? "Open access · Isolated CPU simulation"
                          : "Open access · Live cycle"}
                  </span>
                )
              ) : (
                <>
                  {view === "spending" ? (
                    <button
                      className="button secondary"
                      onClick={exportReport}
                      disabled={!visibleReport}
                    >
                      <ArrowDownToLine size={16} />
                      Export report
                    </button>
                  ) : (
                    <button
                      className="date-button"
                      onClick={() => go("spending")}
                    >
                      {monthName(month)}
                      <ChevronDown size={15} />
                    </button>
                  )}
                  {action}
                </>
              )}
            </div>
          </div>
          {demo && (
            <div className="preview-banner">
              <span>
                <FlaskConical size={15} />
                <strong>A little look around.</strong> You’re exploring sample
                data.
              </span>
              <button onClick={connect}>
                Make it your workspace
                <ArrowRight size={14} />
              </button>
            </div>
          )}
          {error && (
            <div className="error-banner" role="alert">
              <CircleAlert size={18} />
              <span>{error}</span>
              <button
                onClick={() =>
                  user
                    ? transactionsPreparing
                      ? void sync()
                      : void refresh(user)
                    : setDialog("auth")
                }
              >
                {user ? "Try again" : "Sign in"}
              </button>
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => setError(null)}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {loading && (
            <div className="loading-banner" role="status">
              <LoaderCircle size={16} className="spin" />
              Updating your workspace…
            </div>
          )}
          {!demo && (
            <SyncNotice status={counts} busy={busy} retry={() => void sync()} />
          )}

          {view === "overview" && (
            <>
              <FinanceAdvisor
                api={verifierApi}
                demo={!verifierApi}
                onRequireSignIn={() => setDialog("auth")}
              />
              <div className="overview-top-grid">
                <section className="panel worth-panel">
                  <div className="card-heading">
                    <h2>
                      Net worth
                      <span
                        className="info-hint"
                        title="Assets minus credit balances in the sample workspace"
                      >
                        i
                      </span>
                    </h2>
                    <span className="muted small">
                      {demo ? "Sample balances" : "Accounts"}
                    </span>
                  </div>
                  {demo ? (
                    <>
                      <div className="worth-topline">
                        <div>
                          <div className="hero-amount">
                            $42,850<span>.32</span>
                          </div>
                          <p className="positive trend">
                            <ArrowUpRight size={15} />
                            $1,240.00 <span>(2.98%) this month</span>
                          </p>
                        </div>
                        <span className="soft-icon">
                          <TrendingUp size={23} />
                        </span>
                      </div>
                      <NetWorthChart />
                      <div className="worth-footer">
                        <span>
                          <i className="legend-dot coral" />
                          Net worth over time
                        </span>
                        <div className="segmented small-segment">
                          <button className="selected" aria-pressed="true">
                            6M
                          </button>
                          <button
                            onClick={() =>
                              setToast(
                                "This sample contains six months of balance history.",
                              )
                            }
                          >
                            1Y
                          </button>
                          <button
                            onClick={() =>
                              setToast(
                                "You’re viewing all six months in this sample.",
                              )
                            }
                          >
                            All
                          </button>
                        </div>
                      </div>
                    </>
                  ) : (
                    <Empty
                      icon={Landmark}
                      title="Your bigger picture starts here"
                      text={
                        report
                          ? "Your spending report is connected. Account-level balances are not available in this view yet."
                          : "Connect your Sandbox profile to start tracking spending. Account balances will appear when they’re available."
                      }
                      action={
                        report ? (
                          <button
                            className="text-button"
                            onClick={() => go("spending")}
                          >
                            View your spending
                            <ArrowRight size={15} />
                          </button>
                        ) : (
                          action
                        )
                      }
                    />
                  )}
                </section>
                <section className="panel spending-panel">
                  {sectionHeader("Monthly spending", "spending", "Details")}
                  {visibleReport && summary.categories.length ? (
                    <>
                      <Donut
                        categories={summary.categories}
                        total={summary.total}
                      />
                      <div className="spend-comparison">
                        <span
                          className={
                            monthlyChange === null || monthlyChange <= 0
                              ? "positive"
                              : "coral-text"
                          }
                        >
                          <ArrowDownLeft size={14} />
                          {monthlyChange === null
                            ? "—"
                            : `${Math.abs(monthlyChange).toFixed(1)}%`}
                        </span>
                        <span>
                          {monthlyChange === null
                            ? "No previous month to compare"
                            : monthlyChange <= 0
                              ? "less than last month"
                              : "more than last month"}
                        </span>
                      </div>
                      <div className="spending-mini-legend">
                        {summary.categories.slice(0, 3).map((row, i) => (
                          <span key={row.name}>
                            <i
                              className="legend-dot"
                              style={{ background: palette[i] }}
                            />
                            {categoryName(row.name)}
                          </span>
                        ))}
                      </div>
                    </>
                  ) : (
                    <Empty
                      icon={ChartNoAxesCombined}
                      title={
                        transactionsPreparing
                          ? "Transactions are still arriving"
                          : readyEmptyReport
                            ? "No spending categories yet"
                            : "Meet your spending"
                      }
                      text={
                        transactionsPreparing
                          ? "Your spending is unknown while Plaid prepares the transactions. Use Retry sync above to check again."
                          : readyEmptyReport
                            ? "Plaid has finished preparing transactions. The computed report currently has no spending categories."
                            : "Once your first report is ready, your monthly categories will show up here."
                      }
                      action={
                        <button
                          className="button secondary"
                          onClick={() => go("spending")}
                        >
                          Get started
                          <ArrowRight size={15} />
                        </button>
                      }
                    />
                  )}
                </section>
              </div>
              <div className="overview-middle-grid">
                <section className="panel cashflow-panel">
                  {sectionHeader(
                    "This month’s cash flow",
                    "spending",
                    "Explore",
                  )}
                  {demo ? (
                    <>
                      <div className="cash-metrics">
                        <div>
                          <span>
                            <ArrowDownLeft size={15} className="positive" />
                            Money in
                          </span>
                          <strong>$6,250.00</strong>
                        </div>
                        <div>
                          <span>
                            <ArrowUpRight size={15} className="coral-text" />
                            Money out
                          </span>
                          <strong>{money(summary.total)}</strong>
                        </div>
                      </div>
                      <div className="cash-bars">
                        <div style={{ width: "100%" }} />
                        <div
                          style={{
                            width: `${Math.min(100, (summary.total / 625000) * 100)}%`,
                          }}
                        />
                      </div>
                      <div className="cash-remaining">
                        <span>
                          You have{" "}
                          <strong>{money(625000 - summary.total)}</strong> left
                          over
                        </span>
                        <span className="pill positive-pill">
                          <Leaf size={12} />
                          Breathing room
                        </span>
                      </div>
                    </>
                  ) : (
                    <Empty
                      icon={ArrowDownLeft}
                      title="Cash flow is on its way"
                      text="Income and account totals aren’t available yet. Your spending categories are still available below."
                    />
                  )}
                </section>
                <section className="savings-callout">
                  <div>
                    <span className="savings-icon">
                      <Sparkles size={23} />
                    </span>
                    <span className="eyebrow">LOOK AHEAD</span>
                  </div>
                  <h2>
                    Make your next
                    <br />
                    move a little clearer.
                  </h2>
                  <p>
                    Explore two investing styles with paper money, at your own
                    pace.
                  </p>
                  <button onClick={() => go("investing")}>
                    Explore paper investing
                    <ArrowRight size={17} />
                  </button>
                  <span className="callout-orbit orbit-one" />
                  <span className="callout-orbit orbit-two" />
                </section>
              </div>
              <div className="overview-bottom-grid">
                <section className="panel accounts-panel">
                  {sectionHeader("Your accounts", "accounts")}
                  {demo ? (
                    accountRows
                  ) : (
                    <Empty
                      icon={Building2}
                      title={
                        counts
                          ? `${counts.accounts} accounts synced`
                          : "Bring your accounts together"
                      }
                      text={
                        counts
                          ? "Your Sandbox data is connected. Account-level balances aren’t available in this view yet."
                          : "Create a synthetic Sandbox profile to start your first spending report."
                      }
                      action={action}
                    />
                  )}
                </section>
                <section className="panel activity-panel">
                  {sectionHeader(
                    "Recent activity",
                    "spending",
                    "View spending",
                  )}
                  {demo ? (
                    <div className="activity-list">
                      {transactions.slice(0, 3).map((item) => (
                        <div className="activity-row" key={item.name}>
                          <span
                            className="merchant-icon"
                            style={{
                              color: item.color,
                              background: `${item.color}14`,
                            }}
                          >
                            {item.symbol}
                          </span>
                          <span className="row-text">
                            <strong>{item.name}</strong>
                            <span>
                              {item.date} · {item.category}
                            </span>
                          </span>
                          <strong className="transaction-amount">
                            −{money(item.amount)}
                          </strong>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Empty
                      title="Your report is the starting point"
                      text="Transaction-level details aren’t available yet. See your monthly category totals in Spending."
                      action={
                        <button
                          className="text-button"
                          onClick={() => go("spending")}
                        >
                          Open spending
                          <ArrowRight size={15} />
                        </button>
                      }
                    />
                  )}
                </section>
              </div>
            </>
          )}

          {view === "spending" && (
            <>
              <div className="view-toolbar">
                <div className="segmented">
                  <button className="selected">By category</button>
                  <button
                    onClick={() => {
                      if (demo) {
                        const activity =
                          document.getElementById("spending-activity");
                        activity?.focus({ preventScroll: true });
                        activity?.scrollIntoView({ block: "start" });
                      } else
                        setToast(
                          "Transaction-level browsing is not available yet. Your live report contains category totals.",
                        );
                    }}
                  >
                    Activity
                  </button>
                </div>
                <div className="toolbar-right">
                  <label className="select-wrap">
                    <span className="sr-only">Report month</span>
                    <select
                      value={month}
                      onChange={(event) => setMonth(event.target.value)}
                    >
                      {availableMonths.map((value) => (
                        <option key={value} value={value}>
                          {monthName(value)}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={15} />
                  </label>
                  <button
                    className="button secondary"
                    onClick={() => void sync()}
                    disabled={busy}
                  >
                    {busy ? (
                      <LoaderCircle size={16} className="spin" />
                    ) : (
                      <RefreshCw size={16} />
                    )}
                    Refresh
                  </button>
                </div>
              </div>
              {visibleReport && summary.categories.length ? (
                <div className="spending-detail-grid">
                  <section className="panel">
                    <div className="card-heading">
                      <h2>The month so far</h2>
                      <span className="pill neutral-pill">
                        {monthName(month, true)}
                      </span>
                    </div>
                    <Donut
                      categories={summary.categories}
                      total={summary.total}
                    />
                    <p className="chart-caption">
                      Net spending, including refunds. All amounts in USD.
                    </p>
                    <div className="report-meta">
                      <CheckCircle2 size={14} />
                      {demo
                        ? "Sample report"
                        : `Updated ${new Date(visibleReport.computed_at).toLocaleString()}`}
                    </div>
                  </section>
                  <section className="panel category-panel">
                    <div className="card-heading">
                      <h2>Where it went</h2>
                      <span className="muted small">
                        {summary.categories.length} categories
                      </span>
                    </div>
                    {summary.categories.map((row, index) => (
                      <div className="category-row" key={row.name}>
                        <div className="category-line">
                          <span>
                            <i
                              className="legend-dot"
                              style={{
                                background: palette[index % palette.length],
                              }}
                            />
                            {categoryName(row.name)}
                          </span>
                          <strong>{money(row.amount)}</strong>
                        </div>
                        <div className="category-track">
                          <span
                            style={{
                              width: `${summary.total > 0 ? Math.max(0, Math.min(100, (row.amount / summary.total) * 100)) : 0}%`,
                              background: palette[index % palette.length],
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </section>
                </div>
              ) : (
                <section className="panel">
                  <Empty
                    icon={ChartNoAxesCombined}
                    title={
                      loading
                        ? "Bringing your report together"
                        : transactionsPreparing
                          ? "Transactions are still arriving"
                          : readyEmptyReport
                            ? "No spending categories yet"
                            : "A fresh start for your spending"
                    }
                    text={
                      transactionsPreparing
                        ? "Your spending is unknown while Plaid prepares the transactions. Use Retry sync above to check again."
                        : readyEmptyReport
                          ? "Plaid has finished preparing transactions. The computed report currently has no spending categories."
                          : "Connect and sync your Sandbox profile, then we’ll build your first monthly report from the stored transactions."
                    }
                    action={
                      transactionsPreparing || readyEmptyReport
                        ? undefined
                        : action
                    }
                  />
                </section>
              )}
              {demo && (
                <section
                  className="panel table-panel"
                  id="spending-activity"
                  tabIndex={-1}
                >
                  <div className="card-heading">
                    <h2>A few recent moments</h2>
                    <span className="muted small">Sample activity</span>
                  </div>
                  <div
                    className="table-scroll"
                    tabIndex={0}
                    role="region"
                    aria-label="Financial details table"
                  >
                    <table>
                      <thead>
                        <tr>
                          <th>Transaction</th>
                          <th>Date</th>
                          <th>Category</th>
                          <th className="align-right">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {transactions.map((item) => (
                          <tr key={item.name}>
                            <td>
                              <span className="transaction-cell">
                                <span
                                  className="merchant-icon"
                                  style={{
                                    color: item.color,
                                    background: `${item.color}14`,
                                  }}
                                >
                                  {item.symbol}
                                </span>
                                <strong>{item.name}</strong>
                              </span>
                            </td>
                            <td>{item.date}, 2026</td>
                            <td>
                              <span className="pill neutral-pill">
                                {item.category}
                              </span>
                            </td>
                            <td className="align-right strong">
                              −{money(item.amount)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
            </>
          )}

          {view === "accounts" && (
            <>
              <div className="summary-strip">
                <div>
                  <span>Connected accounts</span>
                  <strong>{demo ? "3" : (counts?.accounts ?? "—")}</strong>
                </div>
                <div>
                  <span>Total sample assets</span>
                  <strong>{demo ? "$45,997.97" : "—"}</strong>
                </div>
                <div>
                  <span>Last updated</span>
                  <strong className="text-size">
                    {demo
                      ? "Today, 9:41 AM"
                      : counts
                        ? "Just now"
                        : "Not synced yet"}
                  </strong>
                </div>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void sync()}
                >
                  <RefreshCw size={16} className={busy ? "spin" : ""} />
                  Sync accounts
                </button>
              </div>
              <section className="panel">
                <div className="card-heading">
                  <h2>Your connected accounts</h2>
                  <ShieldCheck size={19} className="muted" />
                </div>
                {demo ? (
                  <>
                    {accountRows}
                    <div className="panel-footnote">
                      <Link2 size={14} />
                      These are synthetic accounts for exploring the workspace.
                    </div>
                  </>
                ) : (
                  <Empty
                    icon={Landmark}
                    title={
                      counts
                        ? "Your Sandbox is connected"
                        : "One place for your money"
                    }
                    text={
                      counts
                        ? `${counts.accounts} accounts were synced. A detailed account listing will appear when it’s available from your service.`
                        : "Create a synthetic profile with savings, a credit card, loans, and investment holdings."
                    }
                    action={action}
                  />
                )}
              </section>
              <div className="reassurance">
                <ShieldCheck size={19} />
                <div>
                  <strong>A clear boundary for your money.</strong>
                  <p>
                    This workspace uses Plaid Sandbox data and Alpaca paper
                    trading. It does not move money between them.
                  </p>
                </div>
              </div>
            </>
          )}

          {view === "cards" && (
            <>
              {demo ? (
                <>
                  <div className="credit-grid">
                    {[
                      {
                        label: "Everyday rewards",
                        bank: "Chase",
                        balance: 238765,
                        apr: "24.49%",
                        minimum: "$74.00",
                        color: "peach-card",
                        digits: "4821",
                      },
                      {
                        label: "Travel card",
                        bank: "Capital One",
                        balance: 76000,
                        apr: "19.99%",
                        minimum: "Unknown",
                        color: "forest-card",
                        digits: "7604",
                      },
                    ].map((card, i) => (
                      <section
                        className={`credit-card ${card.color}`}
                        key={card.label}
                      >
                        <div className="credit-top">
                          <span>{card.bank}</span>
                          <CreditCard size={23} />
                        </div>
                        <p>{card.label}</p>
                        <strong className="credit-balance">
                          {money(card.balance)}
                        </strong>
                        <div className="credit-digits">
                          •••• &nbsp; •••• &nbsp; •••• &nbsp; {card.digits}
                        </div>
                        <div className="credit-details">
                          <span>
                            Purchase APR<strong>{card.apr}</strong>
                          </span>
                          <span>
                            Minimum payment<strong>{card.minimum}</strong>
                          </span>
                          <span>
                            Paydown order<strong>#{i + 1}</strong>
                          </span>
                        </div>
                      </section>
                    ))}
                  </div>
                  <section className="panel">
                    <div className="card-heading">
                      <h2>See the important things first</h2>
                      <span className="pill neutral-pill">Sample figures</span>
                    </div>
                    <div className="insight-row">
                      <span className="soft-icon">
                        <SlidersHorizontal size={22} />
                      </span>
                      <div>
                        <h3>Higher purchase APR comes first</h3>
                        <p>
                          Positive balances with a known purchase APR are ranked
                          from highest to lowest. An unknown payment or APR
                          stays unknown.
                        </p>
                      </div>
                    </div>
                    <div className="panel-footnote">
                      Card rewards and refinance reports will use dated
                      reference tables. Their live views aren’t connected yet.
                    </div>
                  </section>
                </>
              ) : (
                <section className="panel">
                  <Empty
                    icon={CreditCard}
                    title="Compare your card & loan scenarios"
                    text="Run verified payoff, balance-transfer, and refinancing comparisons in Finance advisor."
                    action={
                      <button
                        className="button secondary"
                        onClick={() => go("advisor")}
                      >
                        Open Finance advisor
                        <ArrowRight size={15} />
                      </button>
                    }
                  />
                </section>
              )}
            </>
          )}

          {view === "investing" && (
            <>
              <div className="paper-banner">
                <FlaskConical size={20} />
                <div>
                  <strong>A practice space for your next idea.</strong>
                  <span>
                    All portfolio examples use paper money. Simulated model
                    returns are separate from observed paper fills.
                  </span>
                </div>
                <span className="pill positive-pill">Paper only</span>
              </div>
              {demo ? (
                <>
                  <div className="portfolio-summary">
                    <section className="panel">
                      <span className="eyebrow">PAPER PORTFOLIO VALUE</span>
                      <div className="hero-amount">
                        $21,307<span>.65</span>
                      </div>
                      <p className="positive trend">
                        <ArrowUpRight size={15} />
                        $1,307.65 <span>sample observed paper P&L</span>
                      </p>
                      <div className="portfolio-cash">
                        <span>
                          Cash available<strong>$2,130.76</strong>
                        </span>
                        <span>
                          Sample positions<strong>3</strong>
                        </span>
                      </div>
                    </section>
                    <section className="panel mode-panel">
                      <span className="eyebrow">
                        YOUR PAPER INVESTING STYLE
                      </span>
                      <div className="mode-title">
                        <span className="soft-icon">
                          <Leaf size={22} />
                        </span>
                        <div>
                          <h2>
                            {mode === "stable"
                              ? "Steady & considered"
                              : "Open to more movement"}
                          </h2>
                          <p>
                            {mode === "stable"
                              ? "Stable mode · 안정형"
                              : "Aggressive mode · 위험형"}
                          </p>
                        </div>
                      </div>
                      <p>
                        {mode === "stable"
                          ? "Ranks by Sharpe ratio, with a 20% selection-window drawdown cap. Proposed policy v1 deploys up to 50% of strategy equity."
                          : "Ranks by net return. Proposed policy v1 deploys up to 100% of strategy equity. Both styles require positive confirmation."}
                      </p>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button
                          className="button secondary"
                          onClick={() => setDialog("mode")}
                        >
                          Compare paper modes
                          <ArrowRight size={15} />
                        </button>
                        <button
                          className="button secondary"
                          onClick={() => go("quant")}
                        >
                          <Cpu size={15} />
                          Open CPU quant emulator
                        </button>
                      </div>
                    </section>
                  </div>
                  <section className="panel table-panel">
                    <div className="card-heading">
                      <h2>Sample positions</h2>
                      <span className="muted small">
                        Illustrative paper account
                      </span>
                    </div>
                    <div
                      className="table-scroll"
                      tabIndex={0}
                      role="region"
                      aria-label="Financial details table"
                    >
                      <table>
                        <thead>
                          <tr>
                            <th>Asset</th>
                            <th>Quantity</th>
                            <th>Market value</th>
                            <th>Paper P&L</th>
                            <th>Winning model</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[
                            {
                              s: "AAPL",
                              n: "Apple Inc.",
                              q: "28.5",
                              v: "$6,394.83",
                              p: "+$312.45",
                              m: "M01",
                            },
                            {
                              s: "TLT",
                              n: "iShares 20+ Year Treasury",
                              q: "62.0",
                              v: "$5,687.88",
                              p: "+$84.72",
                              m: "M03",
                            },
                            {
                              s: "BTC/USD",
                              n: "Bitcoin",
                              q: "0.0823",
                              v: "$7,094.18",
                              p: "+$910.48",
                              m: "M08",
                            },
                          ].map((row) => (
                            <tr key={row.s}>
                              <td>
                                <strong>{row.s}</strong>
                                <span className="table-subtitle">{row.n}</span>
                              </td>
                              <td>{row.q}</td>
                              <td className="strong">{row.v}</td>
                              <td className="positive">{row.p}</td>
                              <td>
                                <span className="model-tag">{row.m}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="panel-footnote">
                      Sample positions illustrate the interface; they are not
                      results from a provider cycle or a running strategy.
                    </div>
                  </section>
                </>
              ) : (
                <section className="panel">
                  <Empty
                    icon={TrendingUp}
                    title="Your paper portfolio starts here"
                    text="Portfolio linking and execution aren’t available from your service yet. Explore the sample workspace to preview both investing styles."
                    action={
                      <button
                        className="button secondary"
                        onClick={() => {
                          setDemo(true);
                          setMonth("2026-11");
                        }}
                      >
                        Explore sample portfolio
                        <ArrowRight size={15} />
                      </button>
                    }
                  />
                </section>
              )}
            </>
          )}

          {view === "discovery" && (
            <>
              <div className="view-toolbar">
                <div className="segmented">
                  {["all", "stock", "bond", "crypto"].map((value) => (
                    <button
                      className={sector === value ? "selected" : ""}
                      aria-pressed={sector === value}
                      key={value}
                      onClick={() => setSector(value)}
                    >
                      {
                        {
                          all: "All assets",
                          stock: "Stocks",
                          bond: "Bond ETFs",
                          crypto: "Crypto",
                        }[value]
                      }
                    </button>
                  ))}
                </div>
                {verifierApi && demo ? (
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => setLiveDiscovery((prev) => !prev)}
                  >
                    {liveDiscovery ? "View sample watchlist" : "Load live stored cycle"}
                  </button>
                ) : (
                  <span className="muted small">
                    {demo ? "Sample cycle · Nov 17, 2026" : "Latest stored cycle"}
                  </span>
                )}
              </div>
              {demo && !liveDiscovery ? (
                <section className="panel table-panel">
                  <div className="card-heading">
                    <div>
                      <h2>A focused watchlist</h2>
                      <p className="small muted">
                        Volume first, then the size of daily moves.
                      </p>
                    </div>
                    <span className="pill neutral-pill">Sample selections</span>
                  </div>
                  <div
                    className="table-scroll"
                    tabIndex={0}
                    role="region"
                    aria-label="Financial details table"
                  >
                    <table>
                      <thead>
                        <tr>
                          <th>Asset</th>
                          <th>Sample price</th>
                          <th>Daily move</th>
                          <th>Sample volume</th>
                          <th>Stable winner</th>
                          <th>Aggressive winner</th>
                          <th>
                            <span className="sr-only">Details</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {market
                          .filter(
                            (row) => sector === "all" || row.sector === sector,
                          )
                          .map((row) => (
                            <tr key={row.symbol}>
                              <td>
                                <strong>{row.symbol}</strong>
                                <span className="table-subtitle">
                                  {row.name}
                                </span>
                              </td>
                              <td className="strong">${row.price}</td>
                              <td
                                className={
                                  row.move.startsWith("−")
                                    ? "coral-text"
                                    : "positive"
                                }
                              >
                                {row.move}
                              </td>
                              <td>{row.volume}</td>
                              <td>
                                <span className="model-tag">{row.stable}</span>
                              </td>
                              <td>
                                <span className="model-tag">
                                  {row.aggressive}
                                </span>
                              </td>
                              <td>
                                <button
                                  className="icon-button"
                                  aria-label={`View ${row.symbol} details`}
                                  onClick={() => setSelectedSymbol(row.symbol)}
                                >
                                  <ArrowUpRight size={17} />
                                </button>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ) : (
                <CycleDiscovery
                  key={user?.uid}
                  load={loadCycle}
                  sector={sector}
                />
              )}
              <div className="scope-grid">
                {[
                  {
                    title: "Stocks",
                    body: "Alpaca’s eligible US equity universe, including equity ETFs. IEX or SIP feed, depending on entitlement.",
                  },
                  {
                    title: "Bond ETFs",
                    body: "A versioned seven-ETF watchlist: TLT, IEF, SHY, LQD, HYG, BND, and TIP.",
                  },
                  {
                    title: "Crypto",
                    body: "Eligible Alpaca USD pairs and volume on Alpaca’s own venue, on the equity cycle calendar.",
                  },
                ].map((scope) => (
                  <div key={scope.title}>
                    <span className="eyebrow">{scope.title}</span>
                    <p>{scope.body}</p>
                  </div>
                ))}
              </div>
              <p className="scope-note">
                <CircleHelp size={14} />
                These qualified screens do not represent the whole market.{" "}
                {demo
                  ? "Sample model names are illustrative, not backtest outputs."
                  : "Published selections are screening results, not model-performance winners."}
              </p>
            </>
          )}

          {view === "advisor" && (
            <FinanceAdvisor
              api={verifierApi}
              demo={!verifierApi}
              onRequireSignIn={() => setDialog("auth")}
            />
          )}

          {view === "quant" && (
            <QuantEmulator
              api={verifierApi}
              demo={!verifierApi}
              onRequireSignIn={() => setDialog("auth")}
            />
          )}

          {view === "verifier" && (
            <TickerVerifier
              api={verifierApi}
              demo={!verifierApi}
              onRequireSignIn={() => setDialog("auth")}
            />
          )}

          {view === "settings" && (
            <div className="settings-grid">
              <section className="panel">
                <div className="card-heading">
                  <h2>Your profile</h2>
                  <span className="avatar">
                    {demo
                      ? "AL"
                      : (user?.email?.slice(0, 2).toUpperCase() ?? "YO")}
                  </span>
                </div>
                <div className="setting-row">
                  <span>Workspace</span>
                  <strong>
                    {demo ? "Sample workspace" : "Your Sandbox workspace"}
                  </strong>
                </div>
                <div className="setting-row">
                  <span>Access mode</span>
                  <strong>
                    {user
                      ? user.email ?? "Signed-in account"
                      : verifierApi
                        ? "Open guest access (active — no sign-in required)"
                        : "Sample preview"}
                  </strong>
                </div>
                <div className="setting-row">
                  <span>Data source</span>
                  <strong>
                    {demo ? "Synthetic preview" : "Plaid Sandbox"}
                  </strong>
                </div>
                <div className="setting-actions">
                  {user ? (
                    <button
                      className="button secondary"
                      onClick={() => void logout()}
                    >
                      <LogOut size={16} />
                      Sign out
                    </button>
                  ) : (
                    <button
                      className="button primary"
                      onClick={() => setDialog("auth")}
                    >
                      Sign in to your workspace
                      <ArrowRight size={16} />
                    </button>
                  )}
                  {!demo && (
                    <button
                      className="text-button"
                      onClick={() => {
                        setDemo(true);
                        setMonth("2026-11");
                      }}
                    >
                      Explore sample data
                    </button>
                  )}
                  {demo && user && (
                    <button
                      className="text-button"
                      onClick={() => {
                        setDemo(false);
                        void refresh(user);
                      }}
                    >
                      Return to your data
                    </button>
                  )}
                </div>
              </section>
              <section className="panel">
                <div className="card-heading">
                  <h2>Connections</h2>
                  <span className="soft-icon">
                    <Link2 size={20} />
                  </span>
                </div>
                <div className="setting-row">
                  <span>Account sync</span>
                  <span
                    className={`pill ${counts ? "positive-pill" : "neutral-pill"}`}
                  >
                    {transactionsPreparing
                      ? "Transactions preparing"
                      : counts
                        ? "Connected"
                        : "Not connected"}
                  </span>
                </div>
                <div className="setting-row">
                  <span>Investing environment</span>
                  <strong>Paper only</strong>
                </div>
                <p className="muted small">
                  Create a synthetic Sandbox profile to see your spending. No
                  bank funds are transferred.
                </p>
                <div className="setting-actions">{action}</div>
              </section>
              {me?.role === "admin" && process.env.NEXT_PUBLIC_ADMIN_URL && (
                <section className="panel">
                  <div className="card-heading">
                    <h2>Operations workspace</h2>
                  </div>
                  <p className="muted">
                    Open the independently deployed administrator application.
                  </p>
                  <a
                    className="button secondary"
                    href={process.env.NEXT_PUBLIC_ADMIN_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open operations
                    <ExternalLink size={15} />
                  </a>
                </section>
              )}
            </div>
          )}
          <footer className="workspace-footer">
            <span>
              <span className="tiny-dot" />A little more clarity, every day.
            </span>
            <button onClick={() => setDialog("help")}>
              Questions? We’re here to help
              <ArrowUpRight size={13} />
            </button>
          </footer>
        </main>
      </div>

      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} />
          <span>{toast}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {dialog === "connect" && (
        <Modal
          title="Bring your money into view"
          onClose={() => !busy && setDialog(null)}
        >
          <div className="connect-illustration">
            <span className="connect-bank">
              <Landmark size={30} />
            </span>
            <span className="connect-dots">···</span>
            <span className="brand-mark">h</span>
          </div>
          <p className="modal-intro">Start with a synthetic Sandbox profile.</p>
          <p className="muted">
            We’ll create sample accounts, sync their transactions, and build
            your spending report. No real bank account or money is connected.
          </p>
          <div className="connection-steps">
            {[
              "Create your Sandbox profile",
              "Sync accounts and transactions",
              "See your spending report",
            ].map((label, i) => (
              <div key={label}>
                <span>{i + 1}</span>
                {label}
              </div>
            ))}
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button
            className="button primary full-width"
            disabled={busy}
            onClick={() => void connectSandbox()}
          >
            {busy ? (
              <>
                <LoaderCircle className="spin" size={17} />
                Connecting your Sandbox…
              </>
            ) : (
              <>
                {verifierApi ? "Connect Sandbox profile" : "Sign in and connect"}
                <ArrowRight size={17} />
              </>
            )}
          </button>
          <p className="secure-note">
            <ShieldCheck size={14} />
            Sandbox data only. Credentials stay with your service.
          </p>
        </Modal>
      )}
      {dialog === "auth" && (
        <AuthModal
          onClose={() => setDialog(null)}
          onSuccess={() => {
            setDialog(null);
            setToast("Welcome back. Your workspace is loading.");
          }}
        />
      )}
      {dialog === "search" && (
        <Modal
          title="What are you looking for?"
          onClose={() => setDialog(null)}
        >
          <label className="command-input">
            <Search size={20} />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search your workspace…"
              aria-label="Search your workspace"
            />
          </label>
          <div className="command-results">
            {[
              ...navigation,
              { id: "settings" as View, label: "Settings", icon: Settings2 },
            ]
              .filter((item) =>
                item.label.toLowerCase().includes(query.toLowerCase()),
              )
              .map((item) => (
                <button key={item.id} onClick={() => go(item.id)}>
                  <item.icon size={19} />
                  <span>{item.label}</span>
                  <ArrowRight size={16} />
                </button>
              ))}
            {![...navigation, { label: "Settings" }].some((item) =>
              item.label.toLowerCase().includes(query.toLowerCase()),
            ) && (
              <p className="muted">
                No matching pages. Try “spending” or “accounts”.
              </p>
            )}
          </div>
        </Modal>
      )}
      {dialog === "notifications" && (
        <Modal title="You’re all caught up" onClose={() => setDialog(null)}>
          <Empty
            icon={Bell}
            title={demo ? "A fresh workspace to explore" : "A quiet moment"}
            text={
              demo
                ? "You’re viewing synthetic sample data. Connect your Sandbox profile whenever you’re ready."
                : "There are no new account notifications in this workspace."
            }
            action={
              <button className="button secondary" onClick={connect}>
                Connect account
                <ArrowRight size={15} />
              </button>
            }
          />
        </Modal>
      )}
      {dialog === "help" && (
        <Modal
          title="A little help, right here"
          onClose={() => setDialog(null)}
        >
          <div className="help-list">
            <div>
              <h3>What am I looking at?</h3>
              <p>
                The sample workspace uses synthetic figures. Sign in and connect
                your Sandbox to view reports from your service.
              </p>
            </div>
            <div>
              <h3>Is this real-money investing?</h3>
              <p>
                No. This MVP uses Plaid Sandbox and Alpaca paper trading.
                Simulated model results and observed paper fills stay separate.
              </p>
            </div>
            <div>
              <h3>Where are some of my account details?</h3>
              <p>
                Only available reports are shown. Unknown amounts stay unknown,
                and features that aren’t connected show an empty state.
              </p>
            </div>
          </div>
          <button className="button primary full-width" onClick={connect}>
            Connect your Sandbox
            <ArrowRight size={16} />
          </button>
        </Modal>
      )}
      {dialog === "mode" && (
        <Modal
          title="Find your paper investing style"
          onClose={() => setDialog(null)}
          wide
        >
          <p className="muted">
            Preview the proposed policy v1. This choice changes this sample
            display only; it does not activate a portfolio or submit an order.
          </p>
          <div className="mode-options">
            {(["stable", "aggressive"] as const).map((value) => (
              <button
                className={`mode-option ${mode === value ? "selected" : ""}`}
                key={value}
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
              >
                {value === "stable" ? (
                  <Leaf size={24} />
                ) : (
                  <TrendingUp size={24} />
                )}
                <strong>
                  {value === "stable"
                    ? "Stable · 안정형"
                    : "Aggressive · 위험형"}
                </strong>
                <span>
                  {value === "stable"
                    ? "Rank by Sharpe ratio. Up to 50% deployed, 20% per ticker. Selection drawdown cap: 20%."
                    : "Rank by net return. Up to 100% deployed, 100% per ticker. No selection drawdown filter."}
                </span>
                {mode === value && (
                  <CheckCircle2 size={18} className="mode-check" />
                )}
              </button>
            ))}
          </div>
          <p className="secure-note">
            Both require positive return in the confirmation window. Default: 60
            bars.
          </p>
          <button
            className="button primary full-width"
            onClick={() => {
              setDialog(null);
              setToast(
                `${mode === "stable" ? "Stable" : "Aggressive"} style selected for this preview.`,
              );
            }}
          >
            Use this preview style
            <Check size={16} />
          </button>
        </Modal>
      )}
      {selectedSymbol && (
        <Modal title={selectedSymbol} onClose={() => setSelectedSymbol(null)}>
          <span className="pill neutral-pill">Illustrative sample</span>
          <h3 className="modal-intro">A glimpse of the model comparison</h3>
          <p className="muted">
            A published cycle will show M01–M08, M10, M11, plus the M00
            buy-and-hold baseline, with pinned bars, policy, costs, and both
            mode winners.
          </p>
          <p className="muted">
            This preview does not contain calculated model returns. A missing
            winner means “none,” and M00 can never win.
          </p>
          <button
            className="button secondary full-width"
            onClick={() => {
              setSelectedSymbol(null);
              go("investing");
            }}
          >
            Explore paper modes
            <ArrowRight size={16} />
          </button>
        </Modal>
      )}
    </div>
  );
}

function AuthModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [create, setCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const auth = await identityAuth();
      if (create) await createUserWithEmailAndPassword(auth, email, password);
      else await signInWithEmailAndPassword(auth, email, password);
      onSuccess();
    } catch (caught) {
      const code = (caught as { code?: string }).code;
      setError(
        code === "auth/network-request-failed"
          ? "We couldn’t reach sign-in. Check your connection and try again."
          : code === "auth/too-many-requests"
            ? "Please wait a moment before trying again."
            : code === "auth/weak-password"
              ? "Choose a password with at least 6 characters."
              : code === "auth/email-already-in-use"
                ? "An account already uses this email. Try signing in."
                : authConfigured()
                  ? "We couldn’t sign you in with those details. Please try again."
                  : "Sign-in hasn’t been configured for this workspace yet. You can keep exploring the sample.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function resetPassword() {
    setError("");
    setNotice("");
    if (!email) {
      setError("Enter your email address first.");
      return;
    }
    try {
      await sendPasswordResetEmail(await identityAuth(), email);
      setNotice(
        "If an account uses this email, you’ll receive reset instructions.",
      );
    } catch {
      setError(
        "Reset instructions couldn’t be sent. Check the email address and try again.",
      );
    }
  }
  return (
    <Modal
      title={
        create ? "A fresh start for your finances" : "Welcome back to Harness"
      }
      onClose={onClose}
    >
      <p className="muted">
        Sign in to your Sandbox workspace. Your sample preview is always here to
        explore.
      </p>
      <form onSubmit={(event) => void submit(event)} className="auth-form">
        <label>
          Email address
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
          />
        </label>
        <label>
          Password
          <input
            type="password"
            required
            minLength={create ? 6 : undefined}
            autoComplete={create ? "new-password" : "current-password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Your password"
          />
        </label>
        {!create && (
          <button
            type="button"
            className="text-button auth-reset"
            onClick={() => void resetPassword()}
          >
            Forgot password?
          </button>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="form-notice" role="status">
            {notice}
          </p>
        )}
        <button className="button primary full-width" disabled={busy}>
          {busy ? (
            <LoaderCircle size={17} className="spin" />
          ) : (
            <>
              {create ? "Create workspace" : "Sign in"}
              <ArrowRight size={16} />
            </>
          )}
        </button>
      </form>
      <p className="auth-switch">
        {create ? "Already have a workspace?" : "New to Harness?"}
        <button
          onClick={() => {
            setCreate(!create);
            setError("");
            setNotice("");
          }}
        >
          {create ? "Sign in" : "Create an account"}
        </button>
      </p>
      <div className="secure-note">
        <ShieldCheck size={14} />
        Identity Platform sign-in · Sandbox data only
      </div>
    </Modal>
  );
}
