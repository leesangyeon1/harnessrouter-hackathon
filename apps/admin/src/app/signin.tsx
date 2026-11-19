"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { signInWithEmailAndPassword, signOut } from "firebase/auth";
import {
  ArrowRight,
  LoaderCircle,
  ShieldCheck,
  LockKeyhole,
} from "lucide-react";
import { adminAuth, configured } from "@/lib/firebase";
export function AdminLogin() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const auth = await adminAuth();
      const credential = await signInWithEmailAndPassword(
        auth,
        email,
        password,
      );
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: await credential.user.getIdToken() }),
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok) {
        await signOut(auth);
        throw new Error(
          response.status === 403
            ? "Your account does not have administrator access. Contact the workspace owner."
            : "Administrator access could not be verified. Please try again.",
        );
      }
      router.replace("/workspace");
      router.refresh();
    } catch (caught) {
      setError(
        !configured()
          ? "Administrator sign-in has not been configured for this deployment yet."
          : caught instanceof Error && !caught.message.includes("Firebase")
            ? caught.message
            : "Sign-in failed. Check your credentials and try again.",
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
          <p className="muted">Sign in with an administrator account.</p>
          <form onSubmit={(event) => void submit(event)}>
            <label>
              Email address
              <input
                required
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
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
            Your account’s current role is verified by the service. Customer
            accounts cannot access operations.
          </p>
        </div>
      </section>
    </main>
  );
}
