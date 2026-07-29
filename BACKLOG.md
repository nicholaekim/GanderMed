# GanderMed implementation backlog

Honest state tracking: everything in this file is **not implemented**. The
hardening branch completed Phases 1–4 and 9 of the audit plan (alert
lifecycle, DPD integrity, auth linking, patient-controlled consent + audit,
exposure honesty) plus CI; the invitations branch completed Phase 6 and the
actual-use/patient-notes slice of Phase 7. These remain, in recommended
order.

## Phase 5 — DONE (see CLAUDE.md "Organizations"; blueprint in design/)
Orgs/locations/members with role tiers, hashed staff join links with
minter-staleness fail-closed, org-scoped grants under split unique indexes,
per-request membership enforcement, never-widen consent, org-aware reviews
gate, roster dedupe, unverified labeling everywhere. Deferred: org-scoped
reconciliation dispositions (workspace stays individual-grant-only for the
clinician who opened it — extend via the reviews-route pattern), real org
verification process, multi-org membership (drop one index).
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

## Phase 8 — DONE (see CLAUDE.md "Adherence engine")
Expected slots from per-date schedule history, on_time/late/skipped/missed/
future, PRN never missed, documented formula with null-not-zero "no data",
12-case test matrix incl. mid-window schedule change and DST-safe iteration.
Remaining niceties for later: per-slot drill-down UI, configurable grace
window, timezone per profile (currently single-local-TZ, documented).

## Phase 9 (remainder) — Temporal rule semantics
- Statuses landed (overlap / no_overlap / insufficient_data / unknown), but
  per-rule temporal semantics (dose-separation-sensitive, concurrent-risk,
  cumulative, persistent-PD/enzyme, timing-not-protective) need a ruleset
  schema extension. Never auto-reduce severity from timing.

## Phase 10 — DONE (see CLAUDE.md "Reconciliation workspace")
Deterministic per-med discrepancy flags, sessions with dispositions
(who+when, flags snapshot), pharmacy-confirmed provenance on confirmation
with honest revert on later dose edits, patient-visible history + audit.
Deferred to Phase 11: per-med dispositions printed on the report (the
header line ships now).

## Phase 11 — DONE (see CLAUDE.md "Report & pilot metrics")
Report now carries consent context, per-med reconciliation dispositions,
provenance/actual-use, adherence incl. missed + formula, and versions.
/api/metrics + clinic panel ship the PHI-free pilot aggregates with an
explicit not_instrumented list (reopened alerts, in-wizard drop-off timing
need an event log — still open). Server-side PDF export remains a
cross-cutting deferred item.

## Cross-cutting deferred items
- Email verification flow for password accounts (Resend/Postmark) — until
  then password accounts stay unverified and cannot be Google-link targets
  except via authenticated-session linking.
- Account deletion + data export (PIPEDA).
- Org-level consent language and agreements (custodian/agent).
- Server-generated PDF export; CSV export.
- Rate limiting backed by a shared store when moving off single-instance.
- Production hosting (Canadian region), HTTPS, backups, monitoring.
