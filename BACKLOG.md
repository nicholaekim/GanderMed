# GanderMed implementation backlog

Honest state tracking: everything in this file is **not implemented**. The
hardening branch completed Phases 1–4 and 9 of the audit plan (alert
lifecycle, DPD integrity, auth linking, patient-controlled consent + audit,
exposure honesty) plus CI. These remain, in recommended order.

## Phase 5 — Pharmacy organization model
- Tables: `organizations`, `organization_locations`, `organization_members`
  (roles: owner/admin, pharmacist, staff), staff invitations.
  (`access_grants.organization_id` already exists and is nullable for this.)
- Owner flows: create org, add location, invite/deactivate staff.
- Shared roster: an org member sees patients whose grant names their org —
  requires extending the consent screen so patients approve *an organization
  and location*, not just an individual. Do NOT silently widen existing
  individual grants to orgs.
- Label professional accounts "unverified" until a real verification process
  exists.

## Phase 6 — Pharmacy-initiated invitations and guided intake
- `patient_invitations`: token hash (never the raw token), purpose, location,
  expiry, status timeline (created → opened → intake started → submitted →
  consented → reviewed / expired / cancelled).
- Copyable secure link + QR URL (no email/SMS until a provider is configured).
- Guided intake wizard: sign in/up → see who's asking and why → consent →
  add meds (Rx / OTC / supplements with unverified warnings) → dose,
  schedule, actual-use status (taking / prescribed-not-taking / taking
  differently / recently stopped / unsure) → notes → review → submit.
- Invitation tokens: cryptographically random, stored hashed, expiring,
  single-consumption.

## Phase 7 — Medication editing and provenance
- PATCH for dose/unit/schedule/PRN/instructions/dates/actual-use status/notes.
- Verified DPD identity is immutable — product replacement is an explicit
  replace action (delete+add semantics with history retained).
- Provenance enum: patient-reported / imported / pharmacy-confirmed /
  prescriber-listed / discharge-list / unknown.
- Decide and TEST the review-invalidation rule for dose changes. Recommended:
  dose/schedule edits re-run recompute (alerts re-fingerprint automatically);
  clinician reviews stay attached because the review targets the product
  combination — but the review banner must display "dose changed since this
  review" with the change date. Document whatever is chosen.

## Phase 8 — Real adherence
- Deterministic expected-slot generation (schedule × start/end dates × window
  × timezone), slot matching, statuses: taken-on-time / late / skipped /
  missed / future. PRN never "missed". Distinguish "no data" from 0%.
- Handle mid-window schedule changes and duplicate logs; document the
  percentage formula. Update patient UI, clinic UI, report.
- Test matrix: no logs, on time, late, skipped, missed, future, PRN, partial
  windows, DST boundaries, schedule changes.

## Phase 9 (remainder) — Temporal rule semantics
- Statuses landed (overlap / no_overlap / insufficient_data / unknown), but
  per-rule temporal semantics (dose-separation-sensitive, concurrent-risk,
  cumulative, persistent-PD/enzyme, timing-not-protective) need a ruleset
  schema extension. Never auto-reduce severity from timing.

## Phase 10 — Reconciliation workspace (MedsCheck prep)
- Per-med review row: product/DIN, ingredients, reported dose+schedule,
  actual-use status, recent logs, provenance, verification, patient notes,
  pharmacist notes, discrepancy status.
- Deterministic discrepancy categories (unconfirmed, prescribed-not-taking,
  taking-differently, duplicate ingredient, unverified, recently stopped,
  missing dose/schedule, interaction pending review, adherence incomplete).
- Pharmacist dispositions (confirmed / resolved / follow-up / patient unsure /
  referred) with who+when. Never auto-decide which list is correct.

## Phase 11 — Reports and pilot metrics
- Report additions: consent context, provenance, actual-use, reconciliation
  discrepancies, adherence incl. missed, versions, limitations. Structure for
  a future server-side PDF.
- PHI-free pilot metrics: invitation completion, median intake/review time,
  discrepancies per intake, duplicates found, unverified counts, reviews,
  reopened alerts, revocations, drop-off stage. Mark which are auto-measured.

## Cross-cutting deferred items
- Email verification flow for password accounts (Resend/Postmark) — until
  then password accounts stay unverified and cannot be Google-link targets
  except via authenticated-session linking.
- Account deletion + data export (PIPEDA).
- Org-level consent language and agreements (custodian/agent).
- Server-generated PDF export; CSV export.
- Rate limiting backed by a shared store when moving off single-instance.
- Production hosting (Canadian region), HTTPS, backups, monitoring.
