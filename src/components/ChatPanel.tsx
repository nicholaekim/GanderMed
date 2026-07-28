"use client";

import { useRef, useState } from "react";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const STARTERS = [
  "Explain my alerts in simple words",
  "Which of these matter right now?",
  "What should I ask my pharmacist?",
];

export default function ChatPanel({ patientId }: { patientId?: number }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [needsKey, setNeedsKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    const next = [...messages, { role: "user" as const, content }];
    setMessages(next);
    setInput("");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/chat${patientId ? `?patient=${patientId}` : ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      const data = await res.json();
      if (res.status === 503 && data.error === "needs_key") {
        setNeedsKey(true);
        setMessages(messages);
        return;
      }
      if (!res.ok) {
        setError(data.error ?? "Something went wrong.");
        setMessages(messages);
        return;
      }
      setMessages([...next, { role: "assistant", content: data.reply }]);
      setTimeout(() => scrollRef.current?.scrollTo({ top: 999999, behavior: "smooth" }), 50);
    } catch {
      setError("Network error — is the server running?");
      setMessages(messages);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold">💬 Ask GanderMed AI</h2>
      <p className="mt-0.5 text-xs text-slate-500">
        Explains the alerts and record shown here in plain language. It never decides whether an
        interaction exists and never gives medical advice.
      </p>

      {needsKey ? (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
          <p className="font-semibold">AI explanations need an Anthropic API key.</p>
          <ol className="mt-1 list-decimal space-y-0.5 pl-4">
            <li>
              Get a key at <span className="font-mono">console.anthropic.com</span>
            </li>
            <li>
              Create <span className="font-mono">.env.local</span> in the project folder with{" "}
              <span className="font-mono">ANTHROPIC_API_KEY=sk-ant-…</span>
            </li>
            <li>Restart the dev server</li>
          </ol>
        </div>
      ) : (
        <>
          {messages.length === 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  disabled={busy}
                  className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs text-indigo-800 hover:bg-indigo-100 disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {messages.length > 0 && (
            <div ref={scrollRef} className="mt-3 max-h-80 space-y-2 overflow-y-auto pr-1">
              {messages.map((m, i) => (
                <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                  <div
                    className={`max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm leading-relaxed ${
                      m.role === "user"
                        ? "bg-indigo-600 text-white"
                        : "border border-slate-200 bg-slate-50 text-slate-800"
                    }`}
                  >
                    {m.content}
                  </div>
                </div>
              ))}
              {busy && <p className="text-xs text-slate-400">thinking…</p>}
            </div>
          )}

          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="mt-3 flex gap-2"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about your alerts or medications…"
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            />
            <button
              disabled={busy || !input.trim()}
              className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              Send
            </button>
          </form>
        </>
      )}

      <p className="mt-2 text-[10px] leading-relaxed text-slate-400">
        AI explanations can be wrong and are not medical advice. Conversations are sent to
        Anthropic&apos;s API for processing.
      </p>
    </section>
  );
}
