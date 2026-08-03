// Patient lifecycle transitions — the confirmation half of the medication
// plan story, plus pause/stop/complete for current medications. PATIENT
// ONLY: a clinician can never confirm receipt or a start on the patient's
// behalf (resolveProfileAccess write:true structurally refuses them).
//
// Transitions are guarded: each action names the states it may leave from,
// and an invalid move is a 409, never a silent overwrite.

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getUserFromRequest, resolveProfileAccess } from "@/lib/auth";
import { getMedicationsWithIngredients, recomputeAlerts } from "@/lib/conflicts";
import { annotateAlertsWithExposure, computeExposure } from "@/lib/exposure";
import { attachReviews } from "@/lib/reviews";
import { effectiveLifecycle, isCurrentlyTaken, isPlanned, isPaused, legacyStatusFor, type LifecycleStatus } from "@/lib/lifecycle";
import { clinicianHasLiveAccess, listMedEvents, logMedEvent, notify } from "@/lib/medevents";
import type { Medication } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type Action =
  | "received"
  | "not_received"
  | "start"
  | "not_started"
  | "decline"
  | "taking_differently"
  | "pause"
  | "resume"
  | "stop"
  | "complete"
  | "question"
  | "cancelled_externally";

const PLANNED_STATES: LifecycleStatus[] = ["prescribed", "sent_to_pharmacy", "dispensed", "received_not_started", "not_received"];

// The medication's lifecycle timeline (who did what, when). Same read scope
// as the rest of the record — patients see their own, clinicians need a
// live grant.
export async function GET(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const medId = Number(id);
  if (!Number.isInteger(medId)) return NextResponse.json({ error: "Bad id." }, { status: 400 });

  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const access = resolveProfileAccess(db, user, request, { write: false });
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.status });

  const med = db
    .prepare("SELECT id FROM medications WHERE id = ? AND profile_id = ?")
    .get(medId, access.profileId) as { id: number } | undefined;
  if (!med) return NextResponse.json({ error: "Not found." }, { status: 404 });

  return NextResponse.json({ events: listMedEvents(db, medId) });
}

export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const medId = Number(id);
  if (!Number.isInteger(medId)) return NextResponse.json({ error: "Bad id." }, { status: 400 });

  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const access = resolveProfileAccess(db, user, request, { write: true });
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.status });
  const profileId = access.profileId;

  const med = db
    .prepare("SELECT * FROM medications WHERE id = ? AND profile_id = ?")
    .get(medId, profileId) as unknown as Medication | undefined;
  if (!med) return NextResponse.json({ error: "Not found." }, { status: 404 });

  let body: { action?: Action; date?: string; reason?: string; question?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const action = body.action;
  const lifecycle = effectiveLifecycle(med);
  const reason = (body.reason ?? "").trim().slice(0, 300) || null;

  const refuse = () =>
    NextResponse.json({ error: `Cannot ${action} a medication in state '${lifecycle}'.` }, { status: 409 });

  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  let to: LifecycleStatus | null = null;
  let eventType = "";
  let notifyCreator: { type: string; body: string } | null = null;

  switch (action) {
    case "received": {
      if (!PLANNED_STATES.includes(lifecycle) || lifecycle === "received_not_started") return refuse();
      to = "received_not_started";
      sets.push("patient_received_at = ?");
      args.push(new Date().toISOString());
      eventType = "patient_reported_received";
      break;
    }
    case "not_received": {
      if (!PLANNED_STATES.includes(lifecycle)) return refuse();
      to = "not_received";
      eventType = "patient_reported_not_received";
      notifyCreator = {
        type: "plan_not_received",
        body: `${med.brand_name}: the patient reports NOT receiving this medication${reason ? ` (${reason})` : ""}.`,
      };
      if (reason) {
        sets.push("stop_reason = ?");
        args.push(reason);
      }
      break;
    }
    case "start": {
      if (!PLANNED_STATES.includes(lifecycle)) return refuse();
      const startDate = body.date ?? new Date().toISOString().slice(0, 10);
      if (!DATE_RE.test(startDate)) return NextResponse.json({ error: "date must be YYYY-MM-DD." }, { status: 400 });
      to = "currently_taking";
      // Starting implies having it in hand.
      sets.push("patient_started_at = ?", "patient_received_at = COALESCE(patient_received_at, ?)", "start_date = ?", "actual_use = 'taking'", "stop_reason = NULL");
      args.push(new Date().toISOString(), new Date().toISOString(), startDate);
      eventType = "patient_started";
      notifyCreator = { type: "patient_started", body: `${med.brand_name}: the patient confirmed starting it.` };
      break;
    }
    case "not_started": {
      if (!PLANNED_STATES.includes(lifecycle)) return refuse();
      // Informational: the state stands; the event records the check-in.
      logMedEvent(db, { medicationId: medId, profileId, type: "patient_confirmed_not_started", actorUserId: user.id, actorRole: "patient" });
      return NextResponse.json({ ok: true, lifecycle_status: lifecycle });
    }
    case "decline": {
      if (!PLANNED_STATES.includes(lifecycle)) return refuse();
      to = "declined";
      // end_date bounds the record ("closed on"); the med was never started,
      // so it generates no adherence history either way (inAdherence).
      sets.push("stop_reason = ?", "end_date = ?");
      args.push(reason, new Date().toISOString().slice(0, 10));
      eventType = "patient_declined";
      notifyCreator = {
        type: "plan_declined",
        body: `${med.brand_name}: the patient decided not to start this medication${reason ? ` (${reason})` : ""}.`,
      };
      break;
    }
    case "cancelled_externally": {
      if (!PLANNED_STATES.includes(lifecycle)) return refuse();
      to = "cancelled";
      sets.push("stop_reason = ?", "end_date = ?");
      args.push(reason ?? "Patient reports the prescription was cancelled or replaced", new Date().toISOString().slice(0, 10));
      eventType = "plan_cancelled_reported";
      notifyCreator = {
        type: "plan_cancelled",
        body: `${med.brand_name}: the patient reports this prescription was cancelled or replaced.`,
      };
      break;
    }
    case "taking_differently": {
      if (!isCurrentlyTaken(med)) return refuse();
      to = "taking_differently";
      sets.push("actual_use = 'taking_differently'");
      eventType = "patient_taking_differently";
      notifyCreator = {
        type: "taking_differently",
        body: `${med.brand_name}: the patient reports taking it differently than prescribed.`,
      };
      break;
    }
    case "pause": {
      if (!isCurrentlyTaken(med)) return refuse();
      to = "temporarily_paused";
      sets.push("stop_reason = ?");
      args.push(reason);
      eventType = "patient_paused";
      break;
    }
    case "resume": {
      if (!isPaused(med)) return refuse();
      to = "currently_taking";
      sets.push("stop_reason = NULL", "actual_use = 'taking'");
      eventType = "patient_resumed";
      break;
    }
    case "stop": {
      if (!isCurrentlyTaken(med) && !isPaused(med)) return refuse();
      to = "stopped";
      sets.push("end_date = ?", "stop_reason = ?");
      args.push(new Date().toISOString().slice(0, 10), reason);
      eventType = "patient_stopped";
      break;
    }
    case "complete": {
      if (!isCurrentlyTaken(med) && !isPaused(med)) return refuse();
      to = "completed";
      sets.push("end_date = ?", "stop_reason = ?");
      args.push(new Date().toISOString().slice(0, 10), reason ?? "Course completed");
      eventType = "patient_completed";
      break;
    }
    case "question": {
      const question = (body.question ?? "").trim().slice(0, 500);
      if (question.length < 3) return NextResponse.json({ error: "Write your question first." }, { status: 400 });
      if (isPlanned(med) || isCurrentlyTaken(med) || isPaused(med)) {
        db.prepare("UPDATE medications SET patient_question = ? WHERE id = ?").run(question, medId);
        logMedEvent(db, { medicationId: medId, profileId, type: "patient_question", actorUserId: user.id, actorRole: "patient" });
        if (med.source_user_id && clinicianHasLiveAccess(db, med.source_user_id, profileId)) {
          notify(db, {
            userId: med.source_user_id,
            profileId,
            medicationId: medId,
            type: "patient_question",
            body: `${med.brand_name}: the patient has a question — "${question}"`,
          });
        }
        return NextResponse.json({ ok: true, lifecycle_status: lifecycle });
      }
      return refuse();
    }
    default:
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  // Apply the transition. The legacy status column mirrors the lifecycle so
  // any not-yet-converted code path fails safe.
  sets.push("lifecycle_status = ?", "status = ?");
  args.push(to!, legacyStatusFor(to!));
  db.prepare(`UPDATE medications SET ${sets.join(", ")} WHERE id = ?`).run(...args, medId);

  logMedEvent(db, {
    medicationId: medId,
    profileId,
    type: eventType,
    actorUserId: user.id,
    actorRole: "patient",
    meta: { from: lifecycle, to: to!, ...(reason ? { reason } : {}) },
  });
  if (
    notifyCreator &&
    med.source_user_id &&
    med.source_user_id !== user.id &&
    // Consent gate: a clinician whose access the patient revoked no longer
    // hears about the patient's actions.
    clinicianHasLiveAccess(db, med.source_user_id, profileId)
  ) {
    notify(db, { userId: med.source_user_id, profileId, medicationId: medId, ...notifyCreator });
  }

  const { all } = recomputeAlerts(db, profileId);
  return NextResponse.json({
    ok: true,
    lifecycle_status: to,
    medication: getMedicationsWithIngredients(db, profileId).find((m) => m.id === medId),
    alerts: attachReviews(db, profileId, annotateAlertsWithExposure(all, computeExposure(db, profileId))),
  });
}
