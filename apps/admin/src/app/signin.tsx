"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  LoaderCircle,
  ShieldCheck,
  LockKeyhole,
} from "lucide-react";

export function AdminLogin() {
  const router = useRouter();
  const [adminId, setAdminId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: adminId.trim(),
          password,
        }),
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok) {
        let detail = "";
        try {
          const body = (await response.json()) as { detail?: string };
          detail = body?.detail ?? "";
        } catch {
          detail = "";
        }
        throw new Error(
          detail ||
            (response.status === 401
              ? "Invalid administrator ID or password."
              : "Administrator access could not be verified. Please try again."),
        );
      }
      router.replace("/workspace");
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Sign-in failed. Check your ID and password and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="admin-signin">
      <div className="signin-story">
        <a className="brand" href={process.env.NEXT_PUBLIC_CUSTOMER_URL || "/"}>
          <span className="brand-mark">h</span>harness
          <span className="brand-dot">.</span>
        </a>
        <div>
          <span className="eyebrow">THE OPERATIONS WORKSPACE</span>
          <h1>
            A little clarity.
            <br />
            Behind the scenes.
          </h1>
          <p>
            Keep your compute nodes connected and your finance workspace running
            smoothly.
          </p>
        </div>
        <span className="story-foot">
          <ShieldCheck size={17} />
          Separate access. Shared purpose.
        </span>
      </div>
      <section className="signin-panel">
        <div className="signin-content">
          <span className="login-icon">
            <LockKeyhole size={27} />
          </span>
          <p className="eyebrow">HARNESS OPERATIONS</p>
          <h2>Welcome back.</h2>
          <p className="muted">Sign in with your administrator ID and password.</p>
          <form onSubmit={(event) => void submit(event)}>
            <label>
              Admin ID
              <input
                required
                type="text"
                autoComplete="username"
                value={adminId}
                onChange={(e) => setAdminId(e.target.value)}
                placeholder="admin"
              />
            </label>
            <label>
              Password
              <input
                required
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your password"
              />
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button className="button primary" disabled={busy}>
              {busy ? (
                <>
                  <LoaderCircle size={17} className="spin" />
                  Verifying access…
                </>
              ) : (
                <>
                  Open operations
                  <ArrowRight size={17} />
                </>
              )}
            </button>
          </form>
          <p className="signin-foot">
            <ShieldCheck size={14} />
            Your administrator credentials are verified by the backend service.
          </p>
        </div>
      </section>
    </main>
  );
}
