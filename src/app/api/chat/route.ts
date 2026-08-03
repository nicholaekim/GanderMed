// AI alert-explainer chat. The hard product rule applies here more than
// anywhere: the model EXPLAINS the deterministic engine's structured output —
// it never identifies interactions, re-grades severity, or gives medical
// advice. The grounding context is built server-side from the same pipeline
// the UI uses, and the system prompt forbids going beyond it.

import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getUserFromRequest, resolveProfileAccess } from "@/lib/auth";
import { getMedicationsWithIngredients, recomputeAlerts } from "@/lib/conflicts";
import { effectiveLifecycle, isPlanned, LIFECYCLE_LABELS } from "@/lib/lifecycle";
import { annotateAlertsWithExposure, computeExposure } from "@/lib/exposure";
import { attachReviews } from "@/lib/reviews";
import { RULESET_VERSION } from "@/data/interactionRules";

const MAX_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 2000;

const SYSTEM_PROMPT = (audience: "patient" | "clinician", patientName: string) => `
You are the medication-explanation assistant inside GanderMed, a Canadian medication-safety prototype. You are speaking with ${
  audience === "patient" ? `the patient (${patientName})` : `a member of ${patientName}'s care team`
}.

Below you are given the current structured record: medications (identified via Health Canada's Drug Product Database), safety alerts produced by a deterministic rule engine running a demonstration ruleset, estimated exposure information computed from logged doses, and any clinician reviews.

What you do:
- Explain the listed alerts, ingredients, and terms in plain, calm language (about grade-8 reading level).
- Explain why an alert appeared, what its severity and evidence labels mean, what "estimated active now" means, and what the recommended action is.
- Help prepare specific questions for a pharmacist or prescriber.
- Answer only from the data provided. If something isn't in it, say you don't have that information.

Hard rules you must never break:
- Never identify, suggest, or rule out interactions beyond the alerts listed. If asked about a combination with no alert, say the demonstration ruleset shows no alert for it, that absence of an alert is not proof of safety, and that a pharmacist should confirm.
- Never change, question, downplay, or upgrade an alert's severity, evidence level, or recommended action.
- Never give dosing instructions, and never advise starting, stopping, skipping, or changing any medication.
- No diagnosis. If the user describes symptoms, respond with care and direct them: severe symptoms (trouble breathing, chest pain, uncontrolled bleeding, fainting, signs of overdose) mean call emergency services now; otherwise contact their pharmacist, prescriber, or 811.
- If asked for medical advice, redirect warmly to a pharmacist or prescriber.
- This is a prototype with a demonstration ruleset; mention that briefly when it's relevant.

Style: short answers (usually under 150 words), warm and factual, no alarmism, no moralizing, plain text without markdown headings or tables.
`.trim();

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export async function POST(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const access = resolveProfileAccess(db, user, request, { write: false });
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.status });

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "needs_key" }, { status: 503 });
  }

  let body: { messages?: ChatMessage[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const messages = (body.messages ?? []).slice(-MAX_MESSAGES);
  if (
    messages.length === 0 ||
    messages[messages.length - 1].role !== "user" ||
    messages.some(
      (m) =>
        (m.role !== "user" && m.role !== "assistant") ||
        typeof m.content !== "string" ||
        m.content.length === 0 ||
        m.content.length > MAX_MESSAGE_CHARS
    )
  ) {
    return NextResponse.json({ error: "Invalid conversation." }, { status: 400 });
  }

  // Grounding context — same pipeline the UI uses.
  const profileId = access.profileId;
  const profile = db.prepare("SELECT name FROM profiles WHERE id = ?").get(profileId) as
    | { name: string }
    | undefined;
  const meds = getMedicationsWithIngredients(db, profileId).filter(
    (m) => m.status === "active" || isPlanned(m)
  );
  const { all } = recomputeAlerts(db, profileId);
  const exposure = computeExposure(db, profileId);
  annotateAlertsWithExposure(all, exposure);
  attachReviews(db, profileId, all);

  const context = {
    note: `Demonstration ruleset ${RULESET_VERSION} — not a licensed clinical database. Exposure windows are rough estimates.`,
    medications: meds.map((m) => ({
      name: m.brand_name,
      din: m.din,
      verified: !!m.verified,
      extended_release: !!m.is_extended_release,
      ingredients: m.ingredients.map((i) => ({
        name: i.ingredient_name,
        strength: i.strength ? `${i.strength} ${i.strength_unit ?? ""}`.trim() : null,
      })),
      dose: m.dose_value != null ? `${m.dose_value} ${m.dose_unit ?? ""}`.trim() : null,
      schedule: m.is_prn ? "as needed (PRN)" : JSON.parse(m.schedule_times || "[]"),
      route: m.route,
      lifecycle: LIFECYCLE_LABELS[effectiveLifecycle(m)],
    })),
    alerts: all.map((a) => ({
      severity: a.severity,
      evidence: a.evidence,
      kind: a.kind,
      concern:
        a.concern_class === "planned"
          ? "planned medication — the patient has not confirmed starting it"
          : a.concern_class === "paused"
            ? "involves a temporarily paused medication — not current exposure"
            : "current use",
      between: [a.med_a_name, a.med_b_name],
      ingredients: a.kind === "duplicate" ? [a.ingredient_a] : [a.ingredient_a, a.ingredient_b],
      explanation: a.description,
      recommended_action: a.recommended_action,
      estimated_exposure: a.exposure_status ?? "unknown",
      acknowledged_by_patient: !!a.acknowledged_at,
      clinician_review: a.review
        ? {
            by: a.review.reviewer_name,
            clinic: a.review.reviewer_clinic,
            note: a.review.note,
            valid_until: a.review.expires_at,
          }
        : null,
    })),
    estimated_exposure_now: exposure.report.active_now.map((x) => ({
      ingredient: x.ingredient,
      active_until: x.until,
      typical_half_life_hours: x.half_life_hours,
      window_basis:
        x.window_basis === "effect_duration"
          ? "clinical effect outlasts drug elimination"
          : "washout estimate (about 5 half-lives)",
    })),
    rolling_24h_totals: exposure.report.totals.map((t) => ({
      ingredient: t.ingredient,
      total_mg: t.total_mg,
      usual_daily_max_mg: t.max_daily_mg,
      over_limit: t.over,
      uncounted_doses: t.uncounted.map((u) => `${u.brand_name}: ${u.reason}`),
    })),
  };

  const client = new Anthropic();
  try {
    const response = await client.messages.create({
      model: process.env.CHAT_MODEL || "claude-opus-4-8",
      max_tokens: 1000,
      output_config: { effort: "low" },
      system: [
        {
          type: "text",
          text: `${SYSTEM_PROMPT(user.role === "clinician" ? "clinician" : "patient", profile?.name ?? "the patient")}\n\nCURRENT RECORD (JSON):\n${JSON.stringify(context)}`,
        },
      ],
      messages,
    });

    if (response.stop_reason === "refusal") {
      return NextResponse.json({
        reply:
          "I can't help with that here. For anything about your health or medications beyond the alerts shown, please talk to your pharmacist or prescriber.",
      });
    }

    const reply = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return NextResponse.json({ reply: reply || "I don't have an answer for that — please ask your pharmacist." });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) {
      return NextResponse.json({ error: "needs_key" }, { status: 503 });
    }
    if (e instanceof Anthropic.RateLimitError) {
      return NextResponse.json({ error: "The AI service is rate-limited right now — try again in a minute." }, { status: 502 });
    }
    if (e instanceof Anthropic.APIConnectionError) {
      return NextResponse.json({ error: "Could not reach the AI service — check your internet connection." }, { status: 502 });
    }
    console.error("Chat failed:", e);
    return NextResponse.json({ error: "The AI explainer hit an error — try again." }, { status: 502 });
  }
}
