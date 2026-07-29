# GanderMed implementation backlog

Honest state tracking: everything in this file is **not implemented**. The
hardening branch completed Phases 1–4 and 9 of the audit plan (alert
lifecycle, DPD integrity, auth linking, patient-controlled consent + audit,
exposure honesty) plus CI; the invitations branch completed Phase 6 and the
actual-use/patient-notes slice of Phase 7. These remain, in recommended
order.

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

## Phase 6 — DONE (see README "Invitations & guided intake")
Remaining slice deferred to Phase 5: invitations carry an
`organization_id`/location once orgs exist; today they are scoped to the
individual clinician account. Email/SMS delivery stays out until a provider
is configured — links are handed over in person/printed/QR.

## Phase 7 — DONE (see CLAUDE.md "Medication editing & provenance")
Editing PATCH, immutable identity, explicit Replace (stop-and-retain +
re-alert), provenance enum (server-owned, default patient-reported), and the
tested review-invalidation rule (reviews survive dose edits but carry a
"dose changed since this review" warning; replacement detaches). Remaining
for later phases: setting pharmacy-confirmed provenance is a Phase 10
reconciliation disposition.

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
