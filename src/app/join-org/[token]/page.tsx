"use client";

// Staff join page. Shows who is inviting, the offered role, and the
// unverified badge; the token survives sign-in via ?next=.

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface JoinMeta {
  org_name: string;
  verification_status: string;
  org_role: string;
  invited_by_name: string;
  status: string;
  viewer: "anonymous" | "patient" | "clinician" | "member";
}

export default function JoinOrgPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const [meta, setMeta] = useState<JoinMeta | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/org/join/${token}`).then(async (r) => {
      if (r.status === 404) setNotFound(true);
      else setMeta(await r.json());
    });
  }, [token]);

  async function join() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/org/join/${token}`, { method: "POST" });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Could not join.");
      return;
    }
    router.push("/clinic");
  }

  const shell = (children: React.ReactNode) => (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
      <h1 className="text-center text-2xl font-bold tracking-tight">🪿 GanderMed</h1>
      <p className="mt-1 text-center text-sm text-slate-500">Care-team invitation</p>
      <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">{children}</div>
    </div>
  );

  if (notFound) {
    return shell(
      <p className="text-center text-sm text-slate-500">
        This join link isn&apos;t valid. Check that you copied the whole link, or ask whoever invited
        you for a new one.
      </p>
    );
  }
  if (!meta) return shell(<p className="text-center text-sm text-slate-400">Loading…</p>);

  if (meta.status !== "created") {
    return shell(
      <p className="text-center text-sm text-slate-500">
        This join link is no longer active
        {meta.status === "redeemed" ? " — it was already used" : ""}. Ask for a new one.
      </p>
    );
  }

  return shell(
    <>
      <h2 className="text-lg font-semibold">
        Join {meta.org_name}
        <span className="ml-2 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 align-middle text-[11px] font-medium text-amber-800">
          Unverified organization
        </span>
      </h2>
      <p className="mt-2 text-sm text-slate-600">
        {meta.invited_by_name} invited you to join as <strong>{meta.org_role}</strong>. Members see
        every patient who has approved sharing with the organization.
      </p>
      <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        GanderMed has not verified this organization&apos;s credentials — only join if you recognize
        this pharmacy and the person who invited you.
      </p>

      {meta.viewer === "anonymous" && (
        <div className="mt-4 space-y-2">
          <button
            onClick={() => router.push(`/login?next=${encodeURIComponent(`/join-org/${token}`)}`)}
            className="w-full rounded-lg bg-teal-600 py-2.5 text-sm font-semibold text-white hover:bg-teal-700"
          >
            Sign in to continue
          </button>
          <p className="text-center text-xs text-slate-400">
            You&apos;ll sign in (or create a professional account) and come right back here.
          </p>
        </div>
      )}
      {meta.viewer === "patient" && (
        <p className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          You&apos;re signed in with a patient account. Organization membership is for care-team
          accounts only — sign in with (or create) a professional account to use this link.
        </p>
      )}
      {meta.viewer === "member" && (
        <p className="mt-4 text-center text-sm text-emerald-700">You&apos;re already a member of this organization.</p>
      )}
      {meta.viewer === "clinician" && (
        <>
          {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
          <button
            onClick={join}
            disabled={busy}
            className="mt-4 w-full rounded-lg bg-teal-600 py-2.5 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {busy ? "Joining…" : `Join as ${meta.org_role}`}
          </button>
        </>
      )}
    </>
  );
}
