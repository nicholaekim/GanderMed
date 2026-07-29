# 🪿 GanderMed

*Take a gander at your meds.* (Named for the double meaning — and for Gander, Newfoundland, Canada's most famous story of looking out for people. Formerly "Drug Conflict AI"; run a CIPO trademark + domain check before launch.)

A **Canadian-first medication-safety platform**: record what you take, when, and how much — get explainable warnings when medications shouldn't be combined — and share the record safely with your clinic.

> **Prototype — informational only.** The conflict checks run on a small demonstration ruleset, not a licensed clinical database. They can miss real interactions and flag manageable ones. Nothing this app shows is medical advice; medication decisions belong with a pharmacist or prescriber.

## What it does

- **Search real Canadian products** by brand name or DIN via Health Canada's [Drug Product Database](https://health-products.canada.ca/api/documentation/dpd-documentation-en.html) API (free, nightly-updated). Brand-name search is filtered to marketed products; DIN search finds any product, but **every add is re-verified server-side** — the server resolves brand, DIN, company, ingredients, and status authoritatively from Health Canada (client metadata is never trusted) and refuses to safety-check anything that isn't a currently marketed human product with listed ingredients.
- **Expands combination products into active ingredients** (e.g. Advil Flu → ibuprofen + diphenhydramine), with strengths, route, and dosage form.
- **Duplicate-ingredient detection** — flags when two products share an active ingredient (the classic Tylenol + cold-medicine acetaminophen trap).
- **Drug–drug interaction alerts** from a curated, class-expanded ruleset (~30 rule groups → hundreds of ingredient pairs). Every alert is structured: severity, evidence level, plain-language mechanism, recommended action, source, source version, and user acknowledgment tracking.
- **Dose logging with adherence**: scheduled vs PRN medications, per-slot Take/Skip, automatic "late" status when a dose is logged more than an hour after schedule.
- **Time-aware exposure (v0.2)** — the differentiator. From the doses you *actually logged*:
  - **Estimated active windows** per ingredient ("Ibuprofen active until ~7:36 PM"), from demo exposure profiles; extended-release products are detected and excluded from window modeling.
  - **Rolling 24-hour ingredient totals** across combination products, with per-product source breakdown, OTC daily-max bars, and over-limit warnings. Doses that can't be converted to mg are listed as *uncounted with the reason* — the engine never guesses.
  - **Exposure-tagged alerts**: "⏱ Both estimated active now" vs "No overlap in recorded doses" — an interaction between things you actually took today outranks one between things merely co-listed.
- **Pharmacist-question generator**: each alert expands into specific, deterministic questions to bring to the pharmacy (never advice).
- **Pharmacist report** (`/report`): print-friendly summary of current meds, alerts (with exposure status + questions), 24h totals, and 14-day adherence.
- **Two roles with patient-controlled consent (v0.3, hardened v0.8)**:
  - **Patient accounts**: the full dashboard above, plus an **Access & privacy panel** — a care code that lets a clinician *request* access, pending requests to approve or deny (optionally with a 30/90/180-day expiry), one-click revocation, care-code rotation, and a visible audit trail of who viewed the record and when.
  - **Healthcare-professional accounts** (`/clinic`): entering a patient's care code sends an **access request with a stated purpose** — nothing is visible until the patient approves. The roster shows approved patients with at-a-glance safety stats; records are **view-only** (professionals cannot edit medications, doses, or acknowledgments — their one write is expiring review annotations). Revoked or expired access blocks the very next request. Professional accounts are **not identity-verified** in this prototype.
- **Clinician alert reviews (v0.3)** — the anti-alert-fatigue feature: a professional can mark a combination as reviewed ("Intentional — INR monitored weekly") with a 30/90/180-day validity. Reviewed alerts stay visible but move to a calm "Reviewed by your care team" section for the patient and drop out of the roster's open counts. The review is keyed to the exact combination (products + ingredients + ruleset version), so the system **re-alerts automatically** when a product is swapped, a new product introduces the same pair, the ruleset updates, or the review expires. Reviews never change severity and never hide an alert.
- **Pharmacy-initiated invitations & guided intake (v0.9)** — the onboarding flow for the B2B2C model. A professional mints a secure intake link (only its hash is stored; links expire; no email/SMS — hand it over in person, printed, or as a QR). The patient opens it, sees exactly **who is asking and why**, signs in or creates an account (the link survives the sign-in round-trip, including through Google), builds their medication list with the normal DPD-verified flow, and records **how they actually take each med** ("taking as listed", "not taking this", "taking it differently", "recently stopped", "not sure") plus notes — surfaced as amber provenance callouts in the med list and pharmacist report, never as a safety signal. The wizard ends with an explicit consent decision (approve with optional 30/90/180-day expiry, or decline — declining shares nothing and keeps the list in the patient's own account). The clinic dashboard tracks every invitation through its lifecycle (created → opened → intake in progress → submitted → consented/declined → reviewed, plus expired/cancelled), first-come claiming stops a second account from hijacking a link, and a decided link is dead for replay.

### Design rules (deliberate)

1. **AI never decides whether an interaction exists.** Conflicts come only from the deterministic engine over curated rules ([src/lib/conflicts.ts](src/lib/conflicts.ts)). A future LLM layer may *explain* structured results, never generate or alter them.
2. **Free-text entries are never silently safety-checked.** Products must match Health Canada's database to participate in conflict checking; manual entries are labeled "Unverified — not safety-checked".
3. **Alerts inform, they don't prescribe.** Wording is always "contact your pharmacist", never "do not take" — flagged combinations are sometimes intentional and clinically managed, and stopping abruptly can itself be dangerous.

## Running it

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # deterministic safety/auth/consent suite (no network needed)
```

CI (GitHub Actions) runs type-check, the test suite, and a production build on every push — no live Health Canada access, OAuth, or Anthropic credentials required. See [BACKLOG.md](BACKLOG.md) for the honest list of what is **not** implemented yet (pharmacy organizations, invitations/intake, medication editing, real adherence, reconciliation workspace, pilot metrics).

Requires Node.js 24+ (uses the built-in `node:sqlite` — no native modules). The dev script passes `--use-system-ca` so Node trusts the Windows certificate store; on this machine outbound TLS fails without it.

Data lives in `data/medsafe.db` (SQLite, gitignored — it contains personal health information). The app starts empty — create your own patient or professional account on first run. Delete the `.db` file to reset everything.

**Demo roster (optional, for pitches)**: `node scripts/seed-demo.mjs` (with the dev server running) creates a clinician account (`clinician@demo.test` / `DemoPass123`) and four patients through the real APIs — live Health Canada lookups, backdated dose logs, care-code links to Maple Health Clinic, and one pre-seeded clinician review:

| Patient | Story |
|---|---|
| Margaret Thompson | warfarin + Synthroid + Tums + Advil — major bleeding alert (reviewed by Dr. Osei), levothyroxine-absorption alert |
| Raj Patel | ramipril + spironolactone + Tiazac (extended-release) + metoprolol — hyperkalemia + bradycardia moderates, a late dose |
| Emily Nguyen | sertraline + Tylenol + NyQuil + Advil — SSRI/OTC interactions, uncountable mL doses shown honestly |
| David Okafor | Lipitor + Norvasc — clean record, good adherence (the system doesn't cry wolf) |

All patient accounts use `DemoPass123`. Note: supplements (plain calcium, vitamins) are Natural Health Products in a separate Health Canada database (LNHPD) — not in the DPD; that's a roadmap item.

### Auth: prototype-grade, deliberately

Passwords are salted scrypt hashes; sessions are random tokens in httpOnly cookies; every API route is session-checked and role-scoped (clinicians are read-only, and only for care-code-linked patients).

**"Continue with Google"** is built in (hand-rolled OpenID Connect — start route sets a state cookie, callback exchanges the code server-side and mints the same session cookie). Account linking follows a **safe policy**: a known Google identity signs in; an authenticated session for the same email may link; a *verified* email account auto-links (and other sessions are revoked); an **unverified password account is never silently linked** — this blocks the pre-account-takeover pattern where an attacker registers someone else's email first. Login/registration are rate limited, auth errors are generic, and cookies gain the `Secure` flag in production (`SECURE_COOKIES=1` to force). To enable Google: create a free OAuth client at console.cloud.google.com (Web application, redirect URI `http://localhost:3000/api/auth/google/callback`, add yourself as a test user) and set `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` in `.env.local` (see `.env.example`). That is honest demo auth — **not** clinic-deployment auth. Before selling into a clinic you need: managed authentication with MFA, HTTPS everywhere (cookies currently lack `Secure` for localhost), rate limiting and lockout, audit logging of every record access, encryption at rest, data-residency (Canadian hosting), a PIPEDA/PHIPA privacy review, and likely Health Canada SaMD classification for the alerting feature.

## Architecture

| Piece | File | Notes |
|---|---|---|
| SQLite schema + seeding | [src/lib/db.ts](src/lib/db.ts) | profiles, medications, ingredients, dose_events, interaction_rules, alerts |
| Health Canada DPD client | [src/lib/dpd.ts](src/lib/dpd.ts) | search (`status=2` = marketed only), ingredient/route/form expansion |
| Ingredient normalization | [src/lib/normalize.ts](src/lib/normalize.ts) | salt stripping (warfarin sodium → warfarin), Canadian synonyms (acetylsalicylic acid → aspirin) |
| Conflict engine | [src/lib/conflicts.ts](src/lib/conflicts.ts) | pairwise rule lookup + duplicate detection; syncs the alerts table, preserving acknowledgments |
| Demo ruleset | [src/data/interactionRules.ts](src/data/interactionRules.ts) | class-expanded rule groups, versioned (`demo-2026.07.1`) |
| Exposure engine | [src/lib/exposure.ts](src/lib/exposure.ts) | active windows + rolling 24h totals from dose events; annotates alerts with overlap status |
| Exposure profiles | [src/data/ingredientProfiles.ts](src/data/ingredientProfiles.ts) | demo per-ingredient windows + OTC daily maxima, versioned (`exposure-demo-2026.07.1`) |
| Question generator | [src/lib/questions.ts](src/lib/questions.ts) | deterministic pharmacist questions per alert |
| API | src/app/api/* | search, medications, dose-events, alerts |
| UI | src/app/page.tsx + src/components/* | dashboard: add-med wizard, today schedule, alerts, med list, history |
| Report | [src/app/report/page.tsx](src/app/report/page.tsx) | print-friendly pharmacist summary |

## Roadmap (from the product plan)

- [ ] Replace demo ruleset with a **licensed clinical interaction API** (DrugBank Clinical / Medi-Span / FDB / Lexidrug) — severity and evidence fields are already shaped for this
- [ ] **Pharmacist validation** of the full workflow + a test library of known interaction cases
- [x] **AI explanation layer** — the GanderMed AI chat (Claude) explains structured alerts and the record; it is prompt-forbidden from identifying interactions, re-grading severity, or giving dosing/medical advice. Needs `ANTHROPIC_API_KEY` in `.env.local` (see `.env.example`; `CHAT_MODEL=claude-haiku-4-5` for a cheaper model)
- [ ] Reminders (web push / mobile), caregiver profiles (schema already has `profiles`), French localization
- [ ] Real accounts + sync (PostgreSQL), Canadian hosting, PIPEDA/PHIPA review
- [ ] **Regulatory**: Health Canada Software-as-a-Medical-Device classification before any public launch of the interaction feature

## Data sources

- Product identification: **Health Canada Drug Product Database API** (queried live per search; selected products cached locally)
- Interaction rules, two coexisting layers (each alert cites which one it came from):
  - **Curated demonstration ruleset** (~480 pairs) — hand-written mechanisms and actions; wins pair collisions
  - **DDInter import** (~120k graded pairs) — open-access, literature-curated ([ddinter.scbdd.com](http://ddinter.scbdd.com)). Download the per-ATC CSVs into `data/ddinter/` (kept out of git — free to download, not ours to redistribute), then `npm run import:ddinter`. Re-runnable; skips Unknown-severity pairs.
  - Still **not** a licensed clinical database (DrugBank Clinical / Medi-Span / FDB remain the pre-launch requirement; DrugBank's academic downloads were paused as of July 2026)
- Discontinued option, for the record: NLM's free RxNav interaction API was retired January 2, 2024 — don't plan around it
