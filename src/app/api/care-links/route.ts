import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getUserFromRequest, normalizeShareCode } from "@/lib/auth";
import { recomputeAlerts } from "@/lib/conflicts";
import { attachReviews } from "@/lib/reviews";

// Clinician roster: every linked patient with at-a-glance safety stats.
export async function GET(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (user.role !== "clinician") {
    return NextResponse.json({ error: "Care-team accounts only." }, { status: 403 });
  }

  const links = db
    .prepare(
      `SELECT cl.id AS link_id, p.id AS profile_id, p.name AS patient_name, u.email AS patient_email
       FROM care_links cl
       JOIN profiles p ON p.id = cl.profile_id
       LEFT JOIN users u ON u.id = p.user_id
       WHERE cl.clinician_user_id = ?
       ORDER BY p.name`
    )
    .all(user.id) as unknown as { link_id: number; profile_id: number; patient_name: string; patient_email: string | null }[];

  const roster = links.map((l) => {
    const { all } = recomputeAlerts(db, l.profile_id);
    attachReviews(db, l.profile_id, all);
    // "Open" = needs attention: neither acknowledged by the patient nor
    // covered by an active clinician review.
    const unacked = all.filter((a) => !a.acknowledged_at && !a.review);
    const reviewed = all.filter((a) => a.review && !a.acknowledged_at);
    const activeMeds = db
      .prepare("SELECT COUNT(*) AS n FROM medications WHERE profile_id = ? AND status = 'active'")
      .get(l.profile_id) as { n: number };
    const lastEvent = db
      .prepare(
        `SELECT MAX(de.logged_at) AS last FROM dose_events de
         JOIN medications m ON m.id = de.medication_id WHERE m.profile_id = ?`
      )
      .get(l.profile_id) as { last: string | null };
    return {
      ...l,
      active_medications: activeMeds.n,
      alerts_major: unacked.filter((a) => a.severity === "major").length,
      alerts_moderate: unacked.filter((a) => a.severity === "moderate").length,
      alerts_minor: unacked.filter((a) => a.severity === "minor").length,
      alerts_reviewed: reviewed.length,
      alerts_acknowledged: all.filter((a) => a.acknowledged_at).length,
      last_dose_at: lastEvent.last,
    };
  });

  return NextResponse.json({ roster });
}

// Link a patient to this clinician using the care code the patient shared.
export async function POST(request: Request) {
  const db = getDb();
  const user = getUserFromRequest(db, request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (user.role !== "clinician") {
    return NextResponse.json({ error: "Care-team accounts only." }, { status: 403 });
  }

  let body: { code?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const code = normalizeShareCode(body.code ?? "");
  if (!code) return NextResponse.json({ error: "Care codes look like ABCD-1234." }, { status: 400 });

  const profile = db
    .prepare("SELECT id, name FROM profiles WHERE share_code = ?")
    .get(code) as { id: number; name: string } | undefined;
  if (!profile) return NextResponse.json({ error: "No patient found with that care code." }, { status: 404 });

  db.prepare("INSERT OR IGNORE INTO care_links (clinician_user_id, profile_id) VALUES (?, ?)").run(
    user.id,
    profile.id
  );
  return NextResponse.json({ ok: true, patient_name: profile.name, profile_id: profile.id });
}
