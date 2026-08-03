"use client";

// In-app notifications ("items needing attention"). Per-account only;
// structured so email/push delivery can be added later without changing
// what gets generated.

import { useCallback, useEffect, useState } from "react";
import { fmtDateTime } from "@/lib/format";

interface NotificationView {
  id: number;
  type: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

export default function NotificationsPanel() {
  const [items, setItems] = useState<NotificationView[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/notifications");
    if (res.ok) {
      const data = await res.json();
      setItems(data.notifications ?? []);
      setUnread(data.unread ?? 0);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function markAllRead() {
    await fetch("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "read" }),
    });
    load();
  }

  if (items.length === 0) return null;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between text-left">
        <h2 className="text-base font-semibold">
          Needs your attention
          {unread > 0 && (
            <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700">{unread}</span>
          )}
        </h2>
        <span className="text-xs text-slate-400 underline">{open ? "hide" : "show"}</span>
      </button>
      {(open || unread > 0) && (
        <>
          <ul className="mt-3 space-y-1.5">
            {items
              .filter((n) => open || !n.read_at)
              .slice(0, 8)
              .map((n) => (
                <li
                  key={n.id}
                  className={`rounded-lg border px-3 py-2 text-xs ${
                    n.read_at ? "border-slate-100 text-slate-400" : "border-amber-200 bg-amber-50 text-slate-700"
                  }`}
                >
                  {n.body}
                  <span className="ml-1.5 text-[10px] text-slate-400">{fmtDateTime(n.created_at)}</span>
                </li>
              ))}
          </ul>
          {unread > 0 && (
            <button onClick={markAllRead} className="mt-2 text-xs text-slate-500 underline hover:text-slate-700">
              Mark all read
            </button>
          )}
        </>
      )}
    </section>
  );
}
