# GanderMed — project notes

Canadian medication logger with drug-conflict detection (formerly "Drug Conflict AI"; renamed 2026-07-20). Next.js 15 (App Router, TypeScript, Tailwind v4), SQLite via Node's built-in `node:sqlite` (no native deps — requires Node 24+), `@anthropic-ai/sdk` for the AI explainer chat.

## AI chat (v0.4)

- `src/app/api/chat/route.ts` + `src/components/ChatPanel.tsx`. Claude EXPLAINS the structured record (meds, alerts, exposure, reviews built server-side from the same pipeline as the UI); the system prompt forbids identifying interactions, re-grading severity, or medical/dosing advice. Keep it that way — it's the product's core rule.
- Needs `ANTHROPIC_API_KEY` in `.env.local` (restart dev server); without it the route returns 503 `needs_key` and the UI shows setup steps. Model: `CHAT_MODEL` env override, default `claude-opus-4-8`.

## Auth (v0.3, hardened v0.8)

- Two roles: `patient` (dashboard at `/`) and `clinician` (`/clinic`, strictly view-only). `src/lib/auth.ts`: scrypt password hashes, session tokens in the `dcai_session` httpOnly cookie (Secure flag in production / `SECURE_COOKIES=1`), `resolveProfileAccess()` gates every profile-scoped route (clinician reads require `?patient=<profileId>` + an ACTIVE unexpired `access_grants` row; writes are patient-only). Login/register are rate limited (`src/lib/ratelimit.ts`, in-memory — single instance only).
- **Consent model (v0.8)**: entering a care code creates a PENDING access request (`src/lib/access.ts`); the patient approves/denies/revokes from the AccessPanel, optionally with 30/90/180-day expiry (lazy-expired at check time). `audit_events` records the lifecycle + record opens + review create/revoke + code rotation. `care_links` is dormant — migrated to `access_grants` once, no code reads it.
- **Google linking policy** (`api/auth/google/callback`): known sub → sign in; authenticated same-email session → link; verified email → link + revoke other sessions; unverified password account → BLOCKED (`google_link_blocked`) — prevents pre-account-takeover. `users.email_verified_at`: set for Google users; password accounts stay unverified (no email flow yet).
- Patient registration adopts the oldest unclaimed profile (keeps pre-auth demo data). Local demo accounts: `patient@demo.test` / `clinician@demo.test`, both `DemoPass123`.
- Pages gate client-side via `/api/auth/me` (no Next middleware — edge runtime can't reach node:sqlite); the APIs are the real boundary.
- Google sign-in: `src/lib/google.ts` + `api/auth/google` (+`/callback`) — hand-rolled OIDC, NOT NextAuth. State nonce + chosen role/clinic ride in the `dcai_oauth` httpOnly cookie; id_token decoded without JWKS verification (OK only because it comes straight from Google's token endpoint over TLS). Google-only users have `password_hash=''` (login route special-cases this); `users.google_sub` links accounts by email on first Google login. Config-optional via `GOOGLE_CLIENT_ID/SECRET` (`/api/auth/providers` tells the login page).
- Demo-grade by design: no MFA, rate limiting, audit log, or `Secure` cookie flag (http localhost). README lists the clinic-deployment hardening list.

## Invitations & guided intake (v0.9, Phase 6)

- `patient_invitations` + `src/lib/invitations.ts`: clinician mints an intake link (`/intake/<token>`); only the sha256 `token_hash` is stored — the raw token appears once, in the create response. No email/SMS delivery (so no 'sent' state) — links are handed over in person/printed/QR.
- Status timeline `created→opened→intake_started→intake_submitted→consented|denied→reviewed` (+`expired` lazily at read, +`cancelled`); transitions are forward-only via the TRANSITIONS table. First patient to POST `/start` claims the invitation (`profile_id`); other accounts get 409. After ANY consent decision the token stops accepting writes (410) — found by live smoke, covered by test.
- Consent-approve creates (or reuses/activates — `ux_grants_open`!) a normal ACTIVE `access_grants` row; deny shares nothing. Same enforcement path as care-code consent.
- Routes: `/api/invitations` (+`[id]` cancel/mark_reviewed, owner-only), public `/api/intake/[token]` meta (reveals only who/why, marks opened) + `/start` `/submit` `/consent`. Wizard at `app/intake/[token]/page.tsx`; clinic UI in `components/InvitationsPanel.tsx`.
- Phase 7 slice pulled forward: `medications.actual_use` ('taking'|'not_taking'|'taking_differently'|'recently_stopped'|'unsure') + `patient_notes`, patient-only via PATCH `/api/medications/[id]` — provenance display only (amber badges, report callouts), never a safety signal.
- Login supports `?next=` (validated: leading `/`, no `//` or `\`) through password, register, and Google (rides the `dcai_oauth` state cookie).

## Medication editing & provenance (v0.10, Phase 7)

- PATCH `/api/medications/[id]` (patient-only) edits usage: dose_value/dose_unit/is_prn/schedule_times/start_date/instructions (+status/actual_use/patient_notes from earlier). **Product identity is immutable** (brand/DIN/drug_code/company/route/form/verified/ER) — explicit 400; `provenance`/`last_material_change_at`/`replaced_by_id` are server-owned, also 400.
- **Replace** (`POST /api/medications/[id]/replace` {drug_code}): DPD-verifies the new product, stops+retains the old row (end_date, `replaced_by_id` link, dose history stays put), new row inherits usage fields, start_date=today. One replace per row (409 after). New med id ⇒ review identity breaks ⇒ pair re-alerts — by design.
- **Review-invalidation rule (decided + tested)**: dose/schedule edits (dose_value, dose_unit, is_prn, schedule_times — value must actually differ) stamp `medications.last_material_change_at` (SQLite datetime — same format as review created_at, lexically comparable). attachReviews keeps the review attached (combination unchanged) but sets `review.dose_changed_at` when either med's stamp postdates the review; AlertsPanel shows an amber "dose changed since this review" banner. Product replacement is the only thing that detaches a review.
- `medications.provenance` ('patient-reported' default | imported | pharmacy-confirmed | prescriber-listed | discharge-list | unknown) — server-owned display provenance; shown on the report. Phase 10 reconciliation will set pharmacy-confirmed.

## Adherence engine (v0.11, Phase 8)

- `src/lib/adherence.ts` + `medication_schedule_history`: expected slots are generated per LOCAL date from the schedule **in effect on that date** (history rows with `effective_from`/`effective_to` local datetimes; same-day changes split by slot time). Initial row written on med create/replace; PATCH schedule/PRN changes close+reopen rows via `recordScheduleChange` (self-healing if no open row); migrate backfills `'1970-01-01T00:00'` rows for pre-existing meds; engine synthesizes from current values if a med somehow has zero rows (test fixtures).
- Slot outcomes: event by exact `scheduled_at` match (taken→on_time, late→late, skipped→skipped; latest log wins rogue duplicates — the API already replaces per-slot); no event → `missed` once >60 min past (same grace as the late threshold — a later log converts it, adherence self-corrects at read time), else `future` (excluded from denominators).
- **THE FORMULA** (documented on the report itself): `pct = round(100 × (on_time+late) / (on_time+late+skipped+missed))` over due slots; denominator 0 → `null` rendered as "no data" — NEVER 0%. PRN meds generate no slots, are never missed, and report `unscheduled_doses` instead. Clamps: `start_date` (fallback creation date) → `end_date` for stopped meds.
- Single-local-timezone assumption (documented); dates iterate via local Date components so DST shifts the clock, never the slot count.
- Surfaces: GET `/api/adherence?days=` (resolveProfileAccess), report table + formula footnote, clinic patient AdherenceCard, roster `adherence_pct`/`missed_14d` chip, dashboard summary strip. Computed at read time — never persisted.

## Reconciliation workspace (v0.12, Phase 10)

- `src/lib/reconcile.ts` + `reconciliation_sessions`/`reconciliation_items`: clinician-with-active-grant opens a session on `/clinic/patient/[id]` (one OPEN session per profile+clinician via `ux_recon_open`; re-start resumes), disposes each med (`confirmed|resolved|follow_up|patient_unsure|referred` — who+when + flags-snapshot stored, re-dispose replaces within session), completes with `meds_total` coverage snapshot + summary note. Completed sessions are frozen (409). Every write re-checks the grant — revocation bites mid-session.
- **Discrepancy flags are deterministic and inform-only** (computed at read time in `computeFlags`, NEVER auto-resolve, NEVER touch alerts): unverified, not_taking/taking_differently/recently_stopped/patient_unsure (from actual_use), missing_dose, missing_schedule, patient_note, missed_doses (14d adherence), duplicate_ingredient + interaction_unreviewed (open unacked/unreviewed alerts flag both meds; reviewed/acked alerts don't flag but stay visible in AlertsPanel).
- **Provenance rule**: disposition `confirmed` is the ONE write with a side effect — med provenance → 'pharmacy-confirmed'. A later material dose/schedule PATCH reverts it to 'patient-reported' (the confirmed state no longer exists); instructions/notes edits don't. This + alert reviews are the only clinician writes — everything else stays view-only.
- Routes: GET `/api/reconcile` (resolveProfileAccess read — patients may view their own flags/last-completed), POST start (clinician-only), POST `/api/reconcile/[id]` dispose/complete (owner clinician, open session, live grant). Audit: reconciliation_started/item_disposed/completed (PHI-free). UI: `components/ReconcilePanel.tsx` on the clinic patient page; report header shows "Last pharmacist reconciliation: … N of M reviewed".

## Alert reviews (v0.3)

- `alert_reviews` + `src/lib/reviews.ts`: a clinician review is keyed to the combination identity (kind, med pair ids, ingredient pair, source_version) — NOT the alert row id, which is recreated on every recompute. `attachReviews` re-attaches only while identity holds → automatic re-alert on product change / ruleset bump / expiry. Reviews are soft-revoked (`revoked_at`), never deleted; a new review supersedes the previous one for the same combination.
- Attach reviews everywhere alerts are returned (alerts GET, medications POST/PATCH/DELETE, care-links roster) — the client trusts `alert.review`.
- Roster "open" counts exclude reviewed and acknowledged alerts.
- `scripts/seed-demo.mjs` seeds 4 demo patients through the real APIs (needs the dev server up). Idempotent-ish: skips patients that already have meds. dose-events POST accepts optional `logged_at` for backdating (exists for this script).
- Supplements (plain calcium etc.) are NHPs — in Health Canada's LNHPD, not the DPD. Tums is the DIN'd stand-in for calcium carbonate in demos.

## Commands

- `npm run dev` — dev server on :3000. The script runs node with `--use-system-ca` because this machine's TLS interception breaks Node's bundled CA verification for outbound HTTPS (Health Canada API calls fail without it). Keep that flag.
- `npm test` — golden safety suite (node:test via tsx, in-memory SQLite with real schema + rules). Run it after ANY change to normalize/conflicts/exposure/reviews — these are the safety-critical paths. Add a golden case when fixing any engine bug.
- `npm run import:ddinter` — loads DDInter CSVs from `data/ddinter/` (gitignored; ~120k graded pairs). Rule layering: curated rows (source = RULESET_SOURCE) and DDInter rows coexist in interaction_rules; seedRules deletes/REPLACEs only curated rows (curated wins collisions), the importer deletes/IGNOREs only DDInter rows. Don't "simplify" this back to a full-table wipe — it would destroy the import on every version bump.
- `npx tsc --noEmit` — type check. No ESLint configured.
- DB is `data/medsafe.db`; delete it to reset all user data (schema + rules reseed on next request). Ruleset reseeds automatically when `RULESET_VERSION` changes.

## Hard rules (product decisions, don't undo)

1. Interactions come ONLY from the deterministic engine (`src/lib/conflicts.ts`) over curated rules (`src/data/interactionRules.ts`). No LLM may generate, infer, or re-grade an interaction.
2. Manual/free-text medications are `verified=0` and excluded from conflict checking, labeled as such in the UI.
3. Alert copy says "contact your pharmacist/prescriber", never "do not take" / "stop taking".
4. Every alert carries severity, evidence, source, and source_version; acknowledgments must survive recomputes (see alert-sync logic in `recomputeAlerts`).

## Exposure engine (v0.2)

- `src/lib/exposure.ts` + `src/data/ingredientProfiles.ts`: estimated active windows and rolling 24h mg totals, computed at read time (they decay — never persist them). Only ingredients with a profile row get windows/totals; extended-release products (`is_extended_release`, regex-detected from brand/form) get totals but no windows.
- **Half-life model (v2 profiles)**: each profile stores `half_life_hours` + `window_basis`. Basis `half_life` ⇒ `active_window_hours` MUST equal `round(5 × t½)` (washout convention, ~97% eliminated — deliberately conservative for overlap; enforced by a data-integrity test). Basis `effect_duration` ⇒ the clinical effect outlasts elimination (aspirin's irreversible antiplatelet ~7–10 d, warfarin's factor synthesis, nitrate-separation labels, fluoxetine's norfluoxetine metabolite) and the note MUST explain why (also test-enforced). The exposure LOOKBACK is derived from the longest window in the data — never hand-maintain it. Basis + t½ are surfaced in ExposurePanel and the chat record; bump `EXPOSURE_VERSION` to reseed after any profile change.
- Alert `exposure_status` is computed per read, not stored. Alert ingredient pairs are sorted alphabetically but med ids numerically — annotation must check BOTH med↔ingredient orientations (this was a real bug once).
- Uncountable doses (unit mismatch, mg-of-combination-product) go to `uncounted` with a reason; never silently drop or estimate them.

## Gotchas

- The DB singleton lives on `globalThis` and survives Next hot reload — after any schema/migration change, restart the dev server so `getDb()` runs fresh.

- Ingredient matching happens on `canonical_name` (lowercased, salt-stripped, synonym-mapped — `src/lib/normalize.ts`). DPD names are uppercase with salts ("WARFARIN SODIUM"). If a rule doesn't fire, check normalization first. `KEEP_AS_IS` protects mineral compounds ("ferrous sulfate") from salt stripping.
- DPD search uses `status=2` (marketed only); DIN search skips the status filter. Responses may be a bare object instead of an array — `dpdFetch` normalizes.
- `schedule_times` is a JSON string column (e.g. `["08:00","20:00"]`).
- `logged_at` is UTC ISO; `scheduled_at` is local `YYYY-MM-DDTHH:mm`. Don't compare them lexically. Dose logged >60 min after schedule → status `late` (server-side in `api/dose-events`).
- Launch config `.claude/launch.json` calls node.exe by absolute path (`C:\Program Files\nodejs\node.exe`) because the preview host's PATH predates the Node install.
