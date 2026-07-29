import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { expandRules, RULESET_SOURCE, RULESET_VERSION } from "@/data/interactionRules";
import { EXPOSURE_VERSION, INGREDIENT_PROFILES } from "@/data/ingredientProfiles";
import { detectExtendedRelease } from "@/lib/normalize";
import { generateShareCode } from "@/lib/auth";

declare global {
  // eslint-disable-next-line no-var
  var __dcaiDb: DatabaseSync | undefined;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS medications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL DEFAULT 1 REFERENCES profiles(id),
  drug_code INTEGER,
  din TEXT,
  brand_name TEXT NOT NULL,
  company_name TEXT,
  route TEXT,
  dosage_form TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  dose_value REAL,
  dose_unit TEXT,
  is_prn INTEGER NOT NULL DEFAULT 0,
  schedule_times TEXT NOT NULL DEFAULT '[]',
  start_date TEXT,
  end_date TEXT,
  instructions TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','stopped')),
  actual_use TEXT NOT NULL DEFAULT 'taking' CHECK (actual_use IN
    ('taking','not_taking','taking_differently','recently_stopped','unsure')),
  patient_notes TEXT,
  provenance TEXT NOT NULL DEFAULT 'patient-reported' CHECK (provenance IN
    ('patient-reported','imported','pharmacy-confirmed','prescriber-listed','discharge-list','unknown')),
  last_material_change_at TEXT,
  replaced_by_id INTEGER REFERENCES medications(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS medication_ingredients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  medication_id INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  ingredient_name TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  strength TEXT,
  strength_unit TEXT
);
CREATE INDEX IF NOT EXISTS idx_mi_med ON medication_ingredients(medication_id);
CREATE INDEX IF NOT EXISTS idx_mi_canon ON medication_ingredients(canonical_name);

CREATE TABLE IF NOT EXISTS dose_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  medication_id INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  scheduled_at TEXT,
  logged_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('taken','skipped','late')),
  dose_value REAL,
  dose_unit TEXT
);
CREATE INDEX IF NOT EXISTS idx_de_med ON dose_events(medication_id);
CREATE INDEX IF NOT EXISTS idx_de_sched ON dose_events(scheduled_at);

CREATE TABLE IF NOT EXISTS interaction_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient_a TEXT NOT NULL,
  ingredient_b TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('major','moderate','minor')),
  evidence TEXT NOT NULL,
  mechanism TEXT NOT NULL,
  recommended_action TEXT NOT NULL,
  source TEXT NOT NULL,
  source_version TEXT NOT NULL,
  UNIQUE (ingredient_a, ingredient_b)
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('patient','clinician')),
  clinic_name TEXT,
  google_sub TEXT,
  email_verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS care_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinician_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (clinician_user_id, profile_id)
);

CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  verification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified','verified')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organization_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_org_locations_org ON organization_locations(organization_id);

CREATE TABLE IF NOT EXISTS organization_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_role TEXT NOT NULL CHECK (org_role IN ('owner','admin','pharmacist','staff')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deactivated')),
  invited_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deactivated_at TEXT,
  deactivated_by_user_id INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_org_members_org ON organization_members(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_org_members_single_active
  ON organization_members(user_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS staff_invitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invited_by_user_id INTEGER NOT NULL REFERENCES users(id),
  org_role TEXT NOT NULL CHECK (org_role IN ('admin','pharmacist','staff')),
  invitee_label TEXT,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','redeemed','expired','cancelled')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  redeemed_at TEXT,
  redeemed_by_user_id INTEGER REFERENCES users(id),
  cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_staff_invites_org ON staff_invitations(organization_id, created_at);

CREATE TABLE IF NOT EXISTS reconciliation_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  clinician_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clinician_name TEXT NOT NULL,
  clinic_name TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  summary_note TEXT,
  meds_total INTEGER
);
CREATE INDEX IF NOT EXISTS idx_recon_profile ON reconciliation_sessions(profile_id, started_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_recon_open
  ON reconciliation_sessions(profile_id, clinician_user_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS reconciliation_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES reconciliation_sessions(id) ON DELETE CASCADE,
  medication_id INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  flags TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('confirmed','resolved','follow_up','patient_unsure','referred')),
  note TEXT,
  disposed_by_user_id INTEGER NOT NULL REFERENCES users(id),
  disposed_by_name TEXT NOT NULL,
  disposed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, medication_id)
);

CREATE TABLE IF NOT EXISTS medication_schedule_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  medication_id INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  is_prn INTEGER NOT NULL,
  schedule_times TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT
);
CREATE INDEX IF NOT EXISTS idx_schedhist_med ON medication_schedule_history(medication_id, effective_from);

CREATE TABLE IF NOT EXISTS patient_invitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  clinician_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id INTEGER,
  location_id INTEGER,
  patient_label TEXT,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN
    ('created','opened','intake_started','intake_submitted','consented','denied','reviewed','expired','cancelled')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  opened_at TEXT,
  intake_started_at TEXT,
  submitted_at TEXT,
  consented_at TEXT,
  reviewed_at TEXT,
  patient_note TEXT,
  profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
  grant_id INTEGER REFERENCES access_grants(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_invites_clinician ON patient_invitations(clinician_user_id, created_at);

CREATE TABLE IF NOT EXISTS access_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  clinician_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id INTEGER,
  location_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','denied','revoked','expired')),
  purpose TEXT,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  requested_by_user_id INTEGER NOT NULL REFERENCES users(id),
  decided_at TEXT,
  approved_by_user_id INTEGER REFERENCES users(id),
  starts_at TEXT,
  expires_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_grants_profile ON access_grants(profile_id);
CREATE INDEX IF NOT EXISTS idx_grants_clinician ON access_grants(clinician_user_id);
-- Grant-uniqueness indexes live in migrateColumns (the ux_grants_open family
-- was split for org scoping; recreating the old index here would undo the
-- migration on every boot).

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  actor_user_id INTEGER,
  action TEXT NOT NULL,
  profile_id INTEGER,
  target_id INTEGER,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_profile ON audit_events(profile_id, at);

CREATE TABLE IF NOT EXISTS alert_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ingredient_a TEXT NOT NULL,
  ingredient_b TEXT NOT NULL,
  med_a_id INTEGER NOT NULL,
  med_b_id INTEGER NOT NULL,
  reviewer_user_id INTEGER NOT NULL REFERENCES users(id),
  reviewer_name TEXT NOT NULL,
  reviewer_clinic TEXT,
  note TEXT NOT NULL,
  source_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reviews_profile ON alert_reviews(profile_id);

CREATE TABLE IF NOT EXISTS ingredient_profiles (
  canonical_name TEXT PRIMARY KEY,
  active_window_hours REAL NOT NULL,
  half_life_hours REAL,
  window_basis TEXT NOT NULL DEFAULT 'half_life',
  max_daily_mg REAL,
  note TEXT,
  source_version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL CHECK (kind IN ('interaction','duplicate')),
  severity TEXT NOT NULL,
  evidence TEXT NOT NULL,
  ingredient_a TEXT NOT NULL,
  ingredient_b TEXT NOT NULL,
  med_a_id INTEGER NOT NULL,
  med_b_id INTEGER NOT NULL,
  med_a_name TEXT NOT NULL,
  med_b_name TEXT NOT NULL,
  description TEXT NOT NULL,
  recommended_action TEXT NOT NULL,
  source TEXT NOT NULL,
  source_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  acknowledged_at TEXT,
  UNIQUE (kind, med_a_id, med_b_id, ingredient_a, ingredient_b)
);
`;

function seedRules(db: DatabaseSync) {
  const current = db
    .prepare("SELECT 1 FROM interaction_rules WHERE source_version = ? LIMIT 1")
    .get(RULESET_VERSION);
  if (current) return;

  const rules = expandRules();
  db.exec("BEGIN");
  try {
    // Replace only the curated rows; imported datasets (e.g. DDInter, loaded
    // by scripts/import-ddinter.ts) are managed separately and left intact.
    // OR REPLACE makes curated rules win pair collisions with imports —
    // their hand-written mechanisms and actions are richer.
    db.prepare("DELETE FROM interaction_rules WHERE source = ?").run(RULESET_SOURCE);
    const insert = db.prepare(
      `INSERT OR REPLACE INTO interaction_rules
       (ingredient_a, ingredient_b, severity, evidence, mechanism, recommended_action, source, source_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of rules) {
      insert.run(
        r.ingredient_a, r.ingredient_b, r.severity, r.evidence,
        r.mechanism, r.recommended_action, RULESET_SOURCE, RULESET_VERSION
      );
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function seedIngredientProfiles(db: DatabaseSync) {
  const current = db
    .prepare("SELECT source_version FROM ingredient_profiles LIMIT 1")
    .get() as { source_version: string } | undefined;
  if (current?.source_version === EXPOSURE_VERSION) return;

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM ingredient_profiles").run();
    const insert = db.prepare(
      `INSERT INTO ingredient_profiles
       (canonical_name, active_window_hours, half_life_hours, window_basis, max_daily_mg, note, source_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const [name, p] of Object.entries(INGREDIENT_PROFILES)) {
      insert.run(name, p.active_window_hours, p.half_life_hours, p.window_basis, p.max_daily_mg, p.note, EXPOSURE_VERSION);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// Additive migrations for databases created by earlier versions.
function migrateColumns(db: DatabaseSync) {
  try {
    db.exec("ALTER TABLE medications ADD COLUMN is_extended_release INTEGER NOT NULL DEFAULT 0");
  } catch {
    // column already exists
  }
  try {
    db.exec("ALTER TABLE profiles ADD COLUMN user_id INTEGER REFERENCES users(id)");
  } catch {
    // column already exists
  }
  try {
    db.exec("ALTER TABLE profiles ADD COLUMN share_code TEXT");
  } catch {
    // column already exists
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_share ON profiles(share_code)");
  try {
    db.exec("ALTER TABLE users ADD COLUMN google_sub TEXT");
  } catch {
    // column already exists
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google ON users(google_sub)");
  try {
    db.exec("ALTER TABLE users ADD COLUMN email_verified_at TEXT");
  } catch {
    // column already exists
  }
  try {
    db.exec(
      `ALTER TABLE medications ADD COLUMN actual_use TEXT NOT NULL DEFAULT 'taking' CHECK (actual_use IN
       ('taking','not_taking','taking_differently','recently_stopped','unsure'))`
    );
  } catch {
    // column already exists
  }
  try {
    db.exec("ALTER TABLE medications ADD COLUMN patient_notes TEXT");
  } catch {
    // column already exists
  }
  try {
    db.exec(
      `ALTER TABLE medications ADD COLUMN provenance TEXT NOT NULL DEFAULT 'patient-reported' CHECK (provenance IN
       ('patient-reported','imported','pharmacy-confirmed','prescriber-listed','discharge-list','unknown'))`
    );
  } catch {
    // column already exists
  }
  try {
    db.exec("ALTER TABLE medications ADD COLUMN last_material_change_at TEXT");
  } catch {
    // column already exists
  }
  try {
    db.exec("ALTER TABLE patient_invitations ADD COLUMN reviewed_at TEXT");
  } catch {
    // column already exists
  }
  // Phase 5 org scoping — defensive ALTERs for any vintage of DB file.
  try {
    db.exec("ALTER TABLE access_grants ADD COLUMN organization_id INTEGER");
  } catch {
    // column already exists
  }
  try {
    db.exec("ALTER TABLE access_grants ADD COLUMN location_id INTEGER");
  } catch {
    // column already exists
  }
  try {
    db.exec("ALTER TABLE patient_invitations ADD COLUMN organization_id INTEGER");
  } catch {
    // column already exists
  }
  try {
    db.exec("ALTER TABLE patient_invitations ADD COLUMN location_id INTEGER");
  } catch {
    // column already exists
  }
  // Split grant uniqueness for org scoping: one open INDIVIDUAL grant per
  // (profile, clinician); one open ORG grant per (profile, organization)
  // across all requesters. Pre-Phase-5 rows (organization_id NULL) land
  // under the individual index with identical semantics. Idempotent.
  db.exec("DROP INDEX IF EXISTS ux_grants_open");
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_grants_open_individual
     ON access_grants(profile_id, clinician_user_id)
     WHERE status IN ('pending','active') AND organization_id IS NULL`
  );
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_grants_open_org
     ON access_grants(profile_id, organization_id)
     WHERE status IN ('pending','active') AND organization_id IS NOT NULL`
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_grants_org ON access_grants(organization_id) WHERE organization_id IS NOT NULL"
  );
  try {
    db.exec("ALTER TABLE medications ADD COLUMN replaced_by_id INTEGER REFERENCES medications(id)");
  } catch {
    // column already exists
  }
  // Adherence needs to know what the schedule WAS on each past date. Meds
  // that predate the history table get one open-ended row from their current
  // values ('1970-…' = "as long as we've known"); schedule edits from now on
  // close and reopen rows via recordScheduleChange.
  db.exec(
    `INSERT INTO medication_schedule_history (medication_id, is_prn, schedule_times, effective_from)
     SELECT m.id, m.is_prn, m.schedule_times, '1970-01-01T00:00' FROM medications m
     WHERE NOT EXISTS (SELECT 1 FROM medication_schedule_history h WHERE h.medication_id = m.id)`
  );
  // Existing rows get real values on the next seedIngredientProfiles run —
  // the EXPOSURE_VERSION bump forces a full reseed.
  try {
    db.exec("ALTER TABLE ingredient_profiles ADD COLUMN half_life_hours REAL");
  } catch {
    // column already exists
  }
  try {
    db.exec("ALTER TABLE ingredient_profiles ADD COLUMN window_basis TEXT NOT NULL DEFAULT 'half_life'");
  } catch {
    // column already exists
  }
  // Google-linked accounts proved email ownership through Google's own
  // verification; password accounts stay unverified until a real email flow.
  db.exec(
    "UPDATE users SET email_verified_at = datetime('now') WHERE google_sub IS NOT NULL AND email_verified_at IS NULL"
  );
  // Consent migration: pre-consent care_links become active grants once
  // (idempotent). The care_links table itself is retired from all code paths.
  db.exec(
    `INSERT INTO access_grants (profile_id, clinician_user_id, status, purpose, requested_by_user_id, decided_at, starts_at)
     SELECT cl.profile_id, cl.clinician_user_id, 'active', 'Migrated from prototype care-code link', cl.clinician_user_id, cl.created_at, cl.created_at
     FROM care_links cl
     WHERE NOT EXISTS (
       SELECT 1 FROM access_grants g
       WHERE g.profile_id = cl.profile_id AND g.clinician_user_id = cl.clinician_user_id
     )`
  );
  // Every profile gets a care code (used by clinicians to link patients).
  const missing = db.prepare("SELECT id FROM profiles WHERE share_code IS NULL").all() as unknown as { id: number }[];
  for (const p of missing) {
    db.prepare("UPDATE profiles SET share_code = ? WHERE id = ?").run(generateShareCode(db), p.id);
  }
  // Backfill ER detection for rows inserted before the column existed
  // (idempotent, tiny table at personal-medication scale).
  const meds = db
    .prepare("SELECT id, brand_name, dosage_form, is_extended_release FROM medications")
    .all() as unknown as { id: number; brand_name: string; dosage_form: string | null; is_extended_release: number }[];
  const update = db.prepare("UPDATE medications SET is_extended_release = ? WHERE id = ?");
  for (const m of meds) {
    const er = detectExtendedRelease(m.brand_name, m.dosage_form) ? 1 : 0;
    if (er !== m.is_extended_release) update.run(er, m.id);
  }
}

/**
 * Opens (or creates) a database at `location`, applying the full schema,
 * migrations, and rule seeding. Tests use ":memory:" to get the real
 * engine environment without touching disk.
 */
export function createDatabase(location: string): DatabaseSync {
  const db = new DatabaseSync(location);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrateColumns(db);
  seedRules(db);
  seedIngredientProfiles(db);
  return db;
}

export function getDb(): DatabaseSync {
  if (globalThis.__dcaiDb) return globalThis.__dcaiDb;

  const dir = path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  globalThis.__dcaiDb = createDatabase(path.join(dir, "medsafe.db"));
  return globalThis.__dcaiDb;
}
