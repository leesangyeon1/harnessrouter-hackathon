"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Check,
  CheckCircle2,
  CircleAlert,
  Copy,
  Database,
  ExternalLink,
  KeyRound,
  Layers,
  LoaderCircle,
  LogOut,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { adminAuth, configured } from "@/lib/firebase";
import { QUANT_BENCHMARK_SUMMARY } from "@/lib/quant-cases-data";
import { sessionRequest } from "@/lib/session";
import { PerformanceLog } from "./performance-log";
const operationRequest = (path: string, init: RequestInit = {}) =>
  sessionRequest(path, init, async () => {
    if (!configured()) return null;
    const auth = await adminAuth();
    await auth.authStateReady();
    return auth.currentUser ? auth.currentUser.getIdToken() : null;
  });
type Token = { id: string; created_at: string; revoked_at: string | null };
type Section = "workers" | "performance" | "cycles" | "policies" | "usage";
const stamp = (value: string) =>
  `${new Date(value).toISOString().slice(0, 16).replace("T", " ")} UTC`;

export function Operations({
  initialTokens,
  initialError,
}: {
  initialTokens: Token[];
  initialError: string;
}) {
  const router = useRouter();
  const [tokens, setTokens] = useState<Token[]>(initialTokens);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState(initialError);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState<Section>("workers");
  const [confirm, setConfirm] = useState<string | null>(null);
  const modal = useRef<HTMLDialogElement>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await operationRequest("/api/worker-tokens", {
        cache: "no-store",
        redirect: "error",
      });
      if (response.status === 401 || response.status === 403) {
        setTokens([]);
        setSecret("");
        router.replace("/");
        router.refresh();
        return;
      }
      if (!response.ok)
        throw new Error(
          "Worker credentials could not be loaded. Try refreshing.",
        );
      const data = await response.json();
      if (!Array.isArray(data.tokens))
        throw new Error("The token listing could not be read.");
      setTokens(data.tokens);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The service could not be reached.",
      );
    } finally {
      setLoading(false);
    }
  }, [router]);
  useEffect(() => {
    if (confirm) modal.current?.showModal();
    else modal.current?.close();
  }, [confirm]);

  async function act() {
    if (!confirm) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await operationRequest(
        confirm === "new"
          ? "/api/worker-tokens"
          : `/api/worker-tokens/${encodeURIComponent(confirm)}`,
        {
          method: confirm === "new" ? "POST" : "DELETE",
          cache: "no-store",
          redirect: "error",
        },
      );
      if (!response.ok)
        throw new Error(
          response.status === 403
            ? "Administrator access is no longer available."
            : response.status === 404
              ? "That worker credential is no longer active."
              : "The action could not be completed. Refresh before trying again.",
        );
      if (confirm === "new") {
        const data = await response.json();
        if (typeof data.token !== "string")
          throw new Error("The issued credential could not be read.");
        setSecret(data.token);
        setNotice(
          "Worker credential created. Save it before dismissing this view.",
        );
      } else {
        setNotice(
          "Worker credential revoked. It can no longer claim or upload work.",
        );
      }
      setConfirm(null);
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The service could not be reached.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    setSecret("");
    setTokens([]);
    await fetch("/api/session", { method: "DELETE", redirect: "error" });
    if (configured()) await signOut(await adminAuth());
    router.replace("/");
    router.refresh();
  }
  const activeTokens = tokens.filter((token) => !token.revoked_at).length;
  return (
    <div className="ops-shell">
      <a className="skip-link" href="#ops-main">
        Skip to content
      </a>
      <aside className="ops-sidebar">
        <a className="brand" href="/workspace">
          <span className="brand-mark">h</span>harness
          <span className="brand-dot">.</span>
        </a>
        <span className="ops-label">OPERATIONS</span>
        <nav>
          {(
            [
              { id: "workers", label: "Worker credentials", icon: KeyRound },
              { id: "performance", label: "Performance log", icon: BarChart3 },
              { id: "cycles", label: "Evaluation cycles", icon: Activity },
              { id: "policies", label: "Mode policies", icon: Layers },
              { id: "usage", label: "Usage & issues", icon: Database },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              className={section === item.id ? "active" : ""}
              aria-current={section === item.id ? "page" : undefined}
              onClick={() => setSection(item.id)}
            >
              <item.icon size={18} />
              {item.label}
            </button>
          ))}
        </nav>
        <div className="ops-sidebar-foot">
          <span>
            <ShieldCheck size={15} />
            Administrator workspace
          </span>
          {process.env.NEXT_PUBLIC_CUSTOMER_URL && (
            <a href={process.env.NEXT_PUBLIC_CUSTOMER_URL}>
              <ArrowLeft size={15} />
              Customer workspace
              <ExternalLink size={12} />
            </a>
          )}
          <button disabled={busy || loading} onClick={() => void logout()}>
            <LogOut size={15} />
            Sign out
          </button>
        </div>
      </aside>
      <div className="ops-body">
        <header>
          <span>
            Operations <i>/</i>{" "}
            <strong>
              {
                {
                  workers: "Worker credentials",
                  performance: "Performance log",
                  cycles: "Evaluation cycles",
                  policies: "Mode policies",
                  usage: "Usage & issues",
                }[section]
              }
            </strong>
          </span>
          <span className="verified">
            <ShieldCheck size={13} />
            Admin access verified
          </span>
        </header>
        <main id="ops-main">
          <div className="ops-heading">
            <div>
              <p className="eyebrow">
                {section === "performance" || section === "cycles"
                  ? "QUANT EVALUATION TELEMETRY"
                  : "YOUR WORKSPACE, BEHIND THE SCENES"}
              </p>
              <h1>
                {section === "performance" || section === "cycles"
                  ? "Quant performance log."
                  : "Keep things moving."}
              </h1>
              <p className="muted">
                {section === "performance" || section === "cycles"
                  ? "Cycle-scoped model returns, Sharpe ratios, drawdowns, confirmation gates, and worker node logs."
                  : "A clear view of your compute access and operations."}
              </p>
            </div>
            {section === "workers" && (
              <button
                className="button primary"
                onClick={() => {
                  setError("");
                  setConfirm("new");
                }}
              >
                <Plus size={17} />
                Issue worker credential
              </button>
            )}
          </div>
          {notice && (
            <div className="success" role="status">
              <CheckCircle2 size={17} />
              {notice}
              <button aria-label="Dismiss notice" onClick={() => setNotice("")}>
                <X size={15} />
              </button>
            </div>
          )}
          {error && (
            <div className="error" role="alert">
              <CircleAlert size={17} />
              {error}
              <button onClick={() => void load()}>Try again</button>
            </div>
          )}
          {section === "workers" ? (
            <>
              <div className="ops-stats">
                <section>
                  <span>Active credentials</span>
                  <strong>{loading ? "—" : activeTokens}</strong>
                  <small>Available to CPU workers</small>
                </section>
                <section>
                  <span>Revoked credentials</span>
                  <strong>
                    {loading ? "—" : tokens.length - activeTokens}
                  </strong>
                  <small>No longer accepted by the service</small>
                </section>
                <section>
                  <span>Connection boundary</span>
                  <strong className="small-stat">Outbound HTTPS</strong>
                  <small>No provider credentials on nodes</small>
                </section>
              </div>
              <section className="ops-panel qcase-callout">
                <div>
                  <span className="perf-gov-label">
                    QUANT PERFORMANCE BENCHMARK LOG
                  </span>
                  <h2>
                    {QUANT_BENCHMARK_SUMMARY.totalCases} multi-quant cases ·{" "}
                    {QUANT_BENCHMARK_SUMMARY.profitCases} profit (
                    {QUANT_BENCHMARK_SUMMARY.profitRatePct.toFixed(1)}%) /{" "}
                    {QUANT_BENCHMARK_SUMMARY.lossCases} loss (
                    {QUANT_BENCHMARK_SUMMARY.lossRatePct.toFixed(1)}%)
                  </h2>
                  <p>
                    {QUANT_BENCHMARK_SUMMARY.totalLegExecutions} total execution
                    legs (22 distinct quant strategies &amp; 22 tickers per
                    case) with UTC entry/exit timestamps, prices, fees, Sharpe,
                    drawdown, and cent-reconciled P&amp;L.
                  </p>
                </div>
                <button
                  type="button"
                  className="button primary"
                  onClick={() => setSection("performance")}
                >
                  <BarChart3 size={16} />
                  Open 30-case performance log
                  <ArrowRight size={15} />
                </button>
              </section>
              {secret && (
                <section className="secret-panel">
                  <div>
                    <KeyRound size={20} />
                    <h2>Save this credential now</h2>
                    <button
                      className="icon-button"
                      aria-label="Dismiss and forget credential"
                      onClick={() => {
                        setSecret("");
                        setNotice(
                          "Credential hidden. It cannot be shown again; revoke and issue another if you need a replacement.",
                        );
                      }}
                    >
                      <X size={18} />
                    </button>
                  </div>
                  <p>
                    This is the only time the token is shown. Store it securely
                    on the intended worker node. It is kept only in this page’s
                    memory.
                  </p>
                  <div className="secret-value">
                    <code>{secret}</code>
                    <button
                      className="button secondary"
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(secret)
                          .then(() =>
                            setNotice(
                              "Credential copied. Store it securely on your worker node.",
                            ),
                          )
                          .catch(() =>
                            setError(
                              "Clipboard is unavailable. Select and copy the credential manually.",
                            ),
                          );
                      }}
                    >
                      <Copy size={15} />
                      Copy
                    </button>
                  </div>
                </section>
              )}
              <section className="ops-panel">
                <div className="panel-heading">
                  <div>
                    <h2>Worker credentials</h2>
                    <p>
                      Tokens grant access to claim, read bars, and upload a
                      result.
                    </p>
                  </div>
                  <button
                    className="button secondary"
                    disabled={loading}
                    onClick={() => void load()}
                  >
                    <RefreshCw size={15} className={loading ? "spin" : ""} />
                    Refresh
                  </button>
                </div>
                {loading ? (
                  <div className="ops-empty" role="status">
                    <LoaderCircle className="spin" size={24} />
                    <h3>Loading worker access…</h3>
                  </div>
                ) : tokens.length ? (
                  <div
                    className="table-scroll"
                    tabIndex={0}
                    role="region"
                    aria-label="Worker credentials table"
                  >
                    <table>
                      <thead>
                        <tr>
                          <th>Credential ID</th>
                          <th>Created</th>
                          <th>Status</th>
                          <th>Revoked</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tokens.map((token) => (
                          <tr key={token.id}>
                            <td>
                              <code>{token.id}</code>
                            </td>
                            <td>{stamp(token.created_at)}</td>
                            <td>
                              <span
                                className={`status ${token.revoked_at ? "revoked" : "live"}`}
                              >
                                <span />
                                {token.revoked_at ? "Revoked" : "Active"}
                              </span>
                            </td>
                            <td>
                              {token.revoked_at ? stamp(token.revoked_at) : "—"}
                            </td>
                            <td>
                              {!token.revoked_at && (
                                <button
                                  className="revoke"
                                  onClick={() => {
                                    setError("");
                                    setConfirm(token.id);
                                  }}
                                >
                                  <Trash2 size={14} />
                                  Revoke
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="ops-empty">
                    <KeyRound size={28} />
                    <h3>A clean slate for your compute nodes</h3>
                    <p>
                      Issue a credential for each owner CPU node. Tokens are
                      shown once and can be revoked individually.
                    </p>
                    <button
                      className="button secondary"
                      onClick={() => setConfirm("new")}
                    >
                      Issue the first credential
                      <ArrowRight size={15} />
                    </button>
                  </div>
                )}
              </section>
              <p className="ops-note">
                <ShieldCheck size={15} />
                Access is checked against the database on every request. A
                revoked token cannot continue claiming or uploading work.
              </p>
            </>
          ) : section === "performance" || section === "cycles" ? (
            <PerformanceLog
              key={section}
              defaultMode={section === "cycles" ? "live" : "cases"}
              request={operationRequest}
              onUnauthorized={() => {
                setTokens([]);
                setSecret("");
                router.replace("/");
                router.refresh();
              }}
            />
          ) : (
            <section className="ops-panel">
              <div className="ops-empty">
                <Layers size={30} />
                <h2>
                  {
                    {
                      policies: "Policy publishing is not connected",
                      usage: "Operational metrics are not connected",
                    }[section]
                  }
                </h2>
                <p>
                  {section === "policies"
                    ? "Policy versions are immutable. A later policy must not change the winners or orders of an existing cycle."
                    : "Usage and customer issue visibility will appear when their read APIs are available. No privileged job-start action is exposed."}
                </p>
                <button
                  className="button secondary"
                  onClick={() => setSection("workers")}
                >
                  Back to worker access
                  <ArrowRight size={15} />
                </button>
              </div>
            </section>
          )}
          <footer>
            Harness Operations <span>Sandbox & paper only</span>
          </footer>
        </main>
      </div>
      <dialog
        ref={modal}
        className="confirm-dialog"
        aria-labelledby="confirm-title"
        onCancel={(event) => {
          if (busy) event.preventDefault();
          else setConfirm(null);
        }}
      >
        <div className="panel-heading">
          <h2 id="confirm-title">
            {confirm === "new"
              ? "Issue a new worker credential?"
              : "Revoke this worker credential?"}
          </h2>
          <button
            className="icon-button"
            aria-label="Close confirmation"
            disabled={busy}
            onClick={() => setConfirm(null)}
          >
            <X size={18} />
          </button>
        </div>
        <p>
          {confirm === "new"
            ? "The new token can claim work units, read their bars and upload results. It will be shown once after creation."
            : "The node using this token will lose access to claim, read and upload work. This credential cannot be restored; a new one can be issued."}
        </p>
        <div className="confirm-actions">
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => setConfirm(null)}
          >
            Cancel
          </button>
          <button
            className={`button ${confirm === "new" ? "primary" : "danger"}`}
            disabled={busy}
            onClick={() => void act()}
          >
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : confirm === "new" ? (
              <>
                <Plus size={16} />
                Issue credential
              </>
            ) : (
              <>
                <Check size={16} />
                Revoke credential
              </>
            )}
          </button>
        </div>
      </dialog>
    </div>
  );
}
