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
- Alert `exposure_status` is computed per read, not stored. Alert ingredient pairs are sorted alphabetically but med ids numerically — annotation must check BOTH med↔ingredient orientations (this was a real bug once).
- Uncountable doses (unit mismatch, mg-of-combination-product) go to `uncounted` with a reason; never silently drop or estimate them.

## Gotchas

- The DB singleton lives on `globalThis` and survives Next hot reload — after any schema/migration change, restart the dev server so `getDb()` runs fresh.

- Ingredient matching happens on `canonical_name` (lowercased, salt-stripped, synonym-mapped — `src/lib/normalize.ts`). DPD names are uppercase with salts ("WARFARIN SODIUM"). If a rule doesn't fire, check normalization first. `KEEP_AS_IS` protects mineral compounds ("ferrous sulfate") from salt stripping.
- DPD search uses `status=2` (marketed only); DIN search skips the status filter. Responses may be a bare object instead of an array — `dpdFetch` normalizes.
- `schedule_times` is a JSON string column (e.g. `["08:00","20:00"]`).
- `logged_at` is UTC ISO; `scheduled_at` is local `YYYY-MM-DDTHH:mm`. Don't compare them lexically. Dose logged >60 min after schedule → status `late` (server-side in `api/dose-events`).
- Launch config `.claude/launch.json` calls node.exe by absolute path (`C:\Program Files\nodejs\node.exe`) because the preview host's PATH predates the Node install.
