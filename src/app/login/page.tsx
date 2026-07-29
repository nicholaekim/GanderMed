"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Me } from "@/lib/types";

type RoleTab = "patient" | "clinician";
type Mode = "signin" | "signup";

const OAUTH_ERRORS: Record<string, string> = {
  google_denied: "Google sign-in was cancelled.",
  google_state: "That sign-in attempt expired — please try again.",
  google_failed: "Google sign-in failed — please try again.",
  google_unverified: "Your Google email address isn't verified, so it can't be used here.",
  google_clinic_required:
    "To create a professional account with Google, enter your clinic name below first, then try again.",
  google_link_blocked:
    "An account already exists for this email but hasn't been verified. Sign in with your email and password first, then click “Continue with Google” while signed in to link the two.",
  google_not_configured: "Google sign-in isn't set up on this machine yet.",
};

function GoogleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M45.1 24.5c0-1.6-.1-3.1-.4-4.6H24v8.7h11.8c-.5 2.8-2.1 5.1-4.4 6.7v5.6h7.2c4.2-3.9 6.5-9.6 6.5-16.4z"
      />
      <path
        fill="#34A853"
        d="M24 46c6 0 11-2 14.6-5.4l-7.2-5.6c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.6-3.9-12.3-9.1H4.3v5.8C7.9 40.9 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.7 28c-.4-1.3-.7-2.6-.7-4s.3-2.7.7-4v-5.8H4.3C2.9 17.1 2 20.4 2 24s.9 6.9 2.3 9.8L11.7 28z"
      />
      <path
        fill="#EA4335"
        d="M24 10.9c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C35 4.3 30 2 24 2 15.4 2 7.9 7.1 4.3 14.2l7.4 5.8c1.7-5.2 6.6-9.1 12.3-9.1z"
      />
    </svg>
  );
}

function LoginInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [role, setRole] = useState<RoleTab>("patient");
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [clinicName, setClinicName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [googleReady, setGoogleReady] = useState<boolean | null>(null);
  const [showGoogleSetup, setShowGoogleSetup] = useState(false);

  const oauthError = searchParams.get("error");

  useEffect(() => {
    fetch("/api/auth/providers")
      .then(async (r) => setGoogleReady((await r.json()).google === true))
      .catch(() => setGoogleReady(false));
  }, []);

  useEffect(() => {
    if (oauthError === "google_not_configured") setShowGoogleSetup(true);
  }, [oauthError]);

  function goHome(user: Me) {
    router.replace(user.role === "clinician" ? "/clinic" : "/");
  }

  function startGoogle() {
    if (!googleReady) {
      setShowGoogleSetup(true);
      return;
    }
    const qs = new URLSearchParams({ role });
    if (role === "clinician" && clinicName.trim()) qs.set("clinic_name", clinicName.trim());
    window.location.href = `/api/auth/google?${qs.toString()}`;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(mode === "signin" ? "/api/auth/login" : "/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "signin"
            ? { email, password }
            : { email, password, display_name: name, role, clinic_name: clinicName }
        ),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong.");
        return;
      }
      goHome(data.user as Me);
    } catch {
      setError("Network error — is the server running?");
    } finally {
      setBusy(false);
    }
  }

  const roleCard = (r: RoleTab, emoji: string, title: string, desc: string) => (
    <button
      type="button"
      onClick={() => setRole(r)}
      className={`flex-1 rounded-xl border p-4 text-left transition ${
        role === r
          ? r === "clinician"
            ? "border-teal-400 bg-teal-50 ring-2 ring-teal-200"
            : "border-indigo-400 bg-indigo-50 ring-2 ring-indigo-200"
          : "border-slate-200 bg-white hover:border-slate-300"
      }`}
    >
      <div className="text-2xl">{emoji}</div>
      <div className="mt-1 text-sm font-semibold">{title}</div>
      <div className="mt-0.5 text-xs text-slate-500">{desc}</div>
    </button>
  );

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
      <h1 className="text-center text-2xl font-bold tracking-tight">🪿 GanderMed</h1>
      <p className="mt-1 text-center text-sm text-slate-500">
        Take a gander at your meds — Canadian medication safety for patients and their care teams.
      </p>

      {oauthError && OAUTH_ERRORS[oauthError] && (
        <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {OAUTH_ERRORS[oauthError]}
        </p>
      )}

      <div className="mt-6 flex gap-3">
        {roleCard("patient", "🙂", "I'm a patient", "Log medications, see conflict alerts, share with your clinic.")}
        {roleCard("clinician", "🩺", "Healthcare professional", "View linked patients' medications, alerts, and adherence.")}
      </div>

      <form onSubmit={submit} className="mt-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex gap-4 text-sm font-medium">
          <button
            type="button"
            onClick={() => setMode("signin")}
            className={mode === "signin" ? "border-b-2 border-slate-800 pb-1" : "pb-1 text-slate-400"}
          >
            Sign in
          </button>
          <button
            type="button"
            onClick={() => setMode("signup")}
            className={mode === "signup" ? "border-b-2 border-slate-800 pb-1" : "pb-1 text-slate-400"}
          >
            Create account
          </button>
        </div>

        <div className="mt-4 space-y-3">
          {mode === "signup" && (
            <div>
              <label className="text-xs font-medium text-slate-600">
                {role === "clinician" ? "Your name (e.g. Dr. J. Smith)" : "Your name"}
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-400"
                required
              />
            </div>
          )}
          {role === "clinician" && (
            <div>
              <label className="text-xs font-medium text-slate-600">Clinic / practice name</label>
              <input
                value={clinicName}
                onChange={(e) => setClinicName(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-teal-400"
                required={mode === "signup"}
              />
              {mode === "signin" && (
                <p className="mt-1 text-[10px] text-slate-400">
                  Only needed if signing in with Google creates a new account.
                </p>
              )}
            </div>
          )}
          <div>
            <label className="text-xs font-medium text-slate-600">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-400"
              required
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600">
              Password {mode === "signup" && <span className="text-slate-400">(8+ characters)</span>}
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-400"
              required
              minLength={mode === "signup" ? 8 : undefined}
            />
          </div>

          {error && (
            <div className="text-xs text-red-600">
              <p>{error}</p>
              {mode === "signin" && error === "Invalid email or password." && (
                <p className="mt-0.5 text-slate-500">
                  If you signed up with Google, use the &ldquo;Continue with Google&rdquo; button below.
                </p>
              )}
            </div>
          )}

          <button
            disabled={busy}
            className={`w-full rounded-lg py-2 text-sm font-semibold text-white shadow-sm disabled:opacity-50 ${
              role === "clinician" ? "bg-teal-600 hover:bg-teal-700" : "bg-indigo-600 hover:bg-indigo-700"
            }`}
          >
            {busy
              ? "Working…"
              : mode === "signin"
                ? "Sign in"
                : role === "clinician"
                  ? "Create professional account"
                  : "Create patient account"}
          </button>

          <div className="flex items-center gap-3 py-1">
            <div className="h-px flex-1 bg-slate-200" />
            <span className="text-[11px] uppercase tracking-wide text-slate-400">or</span>
            <div className="h-px flex-1 bg-slate-200" />
          </div>

          <button
            type="button"
            onClick={startGoogle}
            disabled={googleReady === null}
            className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-slate-300 bg-white py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
          >
            <GoogleLogo />
            Continue with Google
          </button>

          {showGoogleSetup && !googleReady && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
              <p className="font-semibold">Google sign-in needs a one-time setup (free):</p>
              <ol className="mt-1 list-decimal space-y-0.5 pl-4">
                <li>
                  Go to <span className="font-mono">console.cloud.google.com</span> → APIs &amp;
                  Services
                </li>
                <li>
                  <strong>OAuth consent screen</strong>: External → fill app name → add yourself as a
                  test user
                </li>
                <li>
                  <strong>Credentials</strong> → Create credentials → OAuth client ID → Web
                  application
                </li>
                <li>
                  Authorized redirect URI (exactly):{" "}
                  <span className="font-mono">http://localhost:3000/api/auth/google/callback</span>
                </li>
                <li>
                  Copy the Client ID + secret into <span className="font-mono">.env.local</span>:{" "}
                  <span className="font-mono">GOOGLE_CLIENT_ID=…</span> and{" "}
                  <span className="font-mono">GOOGLE_CLIENT_SECRET=…</span>
                </li>
                <li>Restart the dev server</li>
              </ol>
            </div>
          )}
        </div>
      </form>

      <p className="mt-4 text-center text-[11px] leading-relaxed text-slate-400">
        Prototype sign-in for demonstration — real clinic deployment requires managed authentication
        with MFA, HTTPS, audit logging, and PIPEDA/PHIPA compliance. Don&apos;t reuse a password you
        use anywhere else.
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<p className="mt-20 text-center text-sm text-slate-400">Loading…</p>}>
      <LoginInner />
    </Suspense>
  );
}
