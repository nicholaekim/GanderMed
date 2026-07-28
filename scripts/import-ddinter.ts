// Imports the DDInter open-access interaction dataset into interaction_rules.
//
//   1. Download the per-ATC CSVs from http://ddinter.scbdd.com/download/
//      into data/ddinter/ (gitignored — the dataset is free to download but
//      not ours to redistribute).
//   2. Run: npm run import:ddinter
//
// Design: curated demo rules (rich hand-written mechanisms) always win pair
// collisions — this importer INSERT OR IGNOREs, and seedRules() uses
// INSERT OR REPLACE. Re-running the importer first clears only previously
// imported DDInter rows, so it's idempotent and survives curated reseeds.

import fs from "node:fs";
import path from "node:path";
import { createDatabase } from "../src/lib/db";
import { canonicalIngredient, titleCase } from "../src/lib/normalize";
import { MAJOR_ACTION, MODERATE_ACTION, MINOR_ACTION } from "../src/data/interactionRules";

const DDINTER_SOURCE = "DDInter (open-access literature-curated database, ddinter.scbdd.com)";
const DDINTER_VERSION = "ddinter-2026.07";

const SEVERITY: Record<string, "major" | "moderate" | "minor"> = {
  Major: "major",
  Moderate: "moderate",
  Minor: "minor",
};
const RANK = { major: 0, moderate: 1, minor: 2 } as const;
const ACTION = { major: MAJOR_ACTION, moderate: MODERATE_ACTION, minor: MINOR_ACTION } as const;

// Minimal CSV line parser with quoted-field support.
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

const dir = path.join(process.cwd(), "data", "ddinter");
if (!fs.existsSync(dir)) {
  console.error(`No ${dir} — download the CSVs from http://ddinter.scbdd.com/download/ first.`);
  process.exit(1);
}
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".csv"));
if (files.length === 0) {
  console.error(`No CSV files in ${dir}.`);
  process.exit(1);
}

type Sev = "major" | "moderate" | "minor";
const pairs = new Map<string, { a: string; b: string; severity: Sev }>();
let rows = 0;
let unknownLevel = 0;
let selfPairs = 0;

for (const file of files) {
  const lines = fs.readFileSync(path.join(dir, file), "utf8").split(/\r?\n/);
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    rows++;
    const cols = parseCsvLine(line);
    if (cols.length < 5) continue;
    const [, drugA, , drugB, level] = cols;
    const severity = SEVERITY[level.trim()];
    if (!severity) {
      unknownLevel++;
      continue;
    }
    const ca = canonicalIngredient(drugA);
    const cb = canonicalIngredient(drugB);
    if (!ca || !cb || ca === cb) {
      selfPairs++;
      continue;
    }
    const [a, b] = [ca, cb].sort();
    const key = `${a}|${b}`;
    const existing = pairs.get(key);
    // The same pair appears in multiple ATC files; keep the most severe grade.
    if (!existing || RANK[severity] < RANK[existing.severity]) {
      pairs.set(key, { a, b, severity });
    }
  }
}

const db = createDatabase(path.join(process.cwd(), "data", "medsafe.db"));
db.exec("BEGIN");
let inserted = 0;
let ignoredCuratedOverlap = 0;
try {
  db.prepare("DELETE FROM interaction_rules WHERE source = ?").run(DDINTER_SOURCE);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO interaction_rules
     (ingredient_a, ingredient_b, severity, evidence, mechanism, recommended_action, source, source_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const { a, b, severity } of pairs.values()) {
    const mechanism =
      `DDInter, a literature-curated interaction database, lists ${titleCase(a)} with ${titleCase(b)} at ` +
      `${severity.toUpperCase()} severity. Mechanism details aren't included in its bulk dataset — ` +
      `ask your pharmacist what this combination means for you.`;
    const info = insert.run(a, b, severity, "moderate", mechanism, ACTION[severity], DDINTER_SOURCE, DDINTER_VERSION);
    if (Number(info.changes) === 1) inserted++;
    else ignoredCuratedOverlap++;
  }
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  throw e;
}

const bySource = db
  .prepare("SELECT source, COUNT(*) AS n FROM interaction_rules GROUP BY source ORDER BY n DESC")
  .all() as unknown as { source: string; n: number }[];

console.log(`DDInter import complete.`);
console.log(`  files parsed:            ${files.length}`);
console.log(`  raw rows:                ${rows}`);
console.log(`  skipped (Unknown level): ${unknownLevel}`);
console.log(`  skipped (same-moiety):   ${selfPairs}`);
console.log(`  unique graded pairs:     ${pairs.size}`);
console.log(`  inserted:                ${inserted}`);
console.log(`  kept curated instead:    ${ignoredCuratedOverlap}`);
console.log(`\nRules by source:`);
for (const r of bySource) console.log(`  ${r.n}  ${r.source}`);
