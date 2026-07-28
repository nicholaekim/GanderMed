// The conflict engine. Deterministic and database-driven: alerts come only
// from curated rules in interaction_rules plus exact duplicate-ingredient
// matches. Nothing here guesses or generates clinical claims.

import type { DatabaseSync } from "node:sqlite";
import type { Alert, Medication, ProductIngredient, Severity } from "@/lib/types";
import { DUPLICATE_MAJOR, MAJOR_ACTION, MODERATE_ACTION, RULESET_VERSION } from "@/data/interactionRules";
import { titleCase } from "@/lib/normalize";

const SEVERITY_RANK: Record<Severity, number> = { major: 0, moderate: 1, minor: 2 };

interface AlertDraft {
  kind: "interaction" | "duplicate";
  severity: string;
  evidence: string;
  ingredient_a: string;
  ingredient_b: string;
  med_a_id: number;
  med_b_id: number;
  med_a_name: string;
  med_b_name: string;
  description: string;
  recommended_action: string;
  source: string;
  source_version: string;
}

function draftKey(d: Pick<AlertDraft, "kind" | "med_a_id" | "med_b_id" | "ingredient_a" | "ingredient_b">) {
  return `${d.kind}|${d.med_a_id}|${d.med_b_id}|${d.ingredient_a}|${d.ingredient_b}`;
}

export function getMedicationsWithIngredients(db: DatabaseSync, profileId: number): Medication[] {
  const meds = db
    .prepare("SELECT * FROM medications WHERE profile_id = ? ORDER BY created_at DESC, id DESC")
    .all(profileId) as unknown as Medication[];
  const ingStmt = db.prepare("SELECT * FROM medication_ingredients WHERE medication_id = ?");
  for (const m of meds) {
    m.ingredients = ingStmt.all(m.id) as unknown as ProductIngredient[];
  }
  return meds;
}

export function recomputeAlerts(db: DatabaseSync, profileId: number): { created: Alert[]; all: Alert[] } {
  const meds = getMedicationsWithIngredients(db, profileId).filter(
    (m) => m.status === "active" && m.verified === 1 && m.ingredients.length > 0
  );

  const ruleStmt = db.prepare(
    "SELECT * FROM interaction_rules WHERE ingredient_a = ? AND ingredient_b = ?"
  );

  const drafts = new Map<string, AlertDraft>();

  for (let i = 0; i < meds.length; i++) {
    for (let j = i + 1; j < meds.length; j++) {
      const [a, b] = meds[i].id < meds[j].id ? [meds[i], meds[j]] : [meds[j], meds[i]];

      // Duplicate active ingredient across two different products.
      const aCanon = new Set(a.ingredients.map((x) => x.canonical_name));
      for (const ing of b.ingredients) {
        if (!aCanon.has(ing.canonical_name)) continue;
        const name = ing.canonical_name;
        const severity = DUPLICATE_MAJOR.has(name) ? "major" : "moderate";
        const d: AlertDraft = {
          kind: "duplicate",
          severity,
          evidence: "high",
          ingredient_a: name,
          ingredient_b: name,
          med_a_id: a.id,
          med_b_id: b.id,
          med_a_name: a.brand_name,
          med_b_name: b.brand_name,
          description: `Both products contain ${titleCase(name)}. Doses add up across products, so it is easy to exceed the safe daily total without realizing it.`,
          recommended_action: severity === "major" ? MAJOR_ACTION : MODERATE_ACTION,
          source: "Duplicate active-ingredient check (Health Canada DPD ingredient listings)",
          source_version: RULESET_VERSION,
        };
        drafts.set(draftKey(d), d);
      }

      // Pairwise interaction rules between different ingredients.
      for (const ingA of a.ingredients) {
        for (const ingB of b.ingredients) {
          if (ingA.canonical_name === ingB.canonical_name) continue;
          const [x, y] = [ingA.canonical_name, ingB.canonical_name].sort();
          const rule = ruleStmt.get(x, y) as
            | { severity: string; evidence: string; mechanism: string; recommended_action: string; source: string; source_version: string }
            | undefined;
          if (!rule) continue;
          const d: AlertDraft = {
            kind: "interaction",
            severity: rule.severity,
            evidence: rule.evidence,
            ingredient_a: x,
            ingredient_b: y,
            med_a_id: a.id,
            med_b_id: b.id,
            med_a_name: a.brand_name,
            med_b_name: b.brand_name,
            description: rule.mechanism,
            recommended_action: rule.recommended_action,
            source: rule.source,
            source_version: rule.source_version,
          };
          drafts.set(draftKey(d), d);
        }
      }
    }
  }

  // Sync the alerts table: insert new findings, remove ones that no longer
  // apply (medication stopped/removed), preserve acknowledgments for the rest.
  const existing = db.prepare("SELECT * FROM alerts WHERE profile_id = ?").all(profileId) as unknown as Alert[];
  const existingByKey = new Map(existing.map((e) => [draftKey(e), e]));

  const created: Alert[] = [];
  db.exec("BEGIN");
  try {
    for (const e of existing) {
      if (!drafts.has(draftKey(e))) {
        db.prepare("DELETE FROM alerts WHERE id = ?").run(e.id);
      }
    }
    const insert = db.prepare(
      `INSERT INTO alerts
       (profile_id, kind, severity, evidence, ingredient_a, ingredient_b, med_a_id, med_b_id,
        med_a_name, med_b_name, description, recommended_action, source, source_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const [key, d] of drafts) {
      if (existingByKey.has(key)) continue;
      const info = insert.run(
        profileId, d.kind, d.severity, d.evidence, d.ingredient_a, d.ingredient_b,
        d.med_a_id, d.med_b_id, d.med_a_name, d.med_b_name,
        d.description, d.recommended_action, d.source, d.source_version
      );
      const row = db.prepare("SELECT * FROM alerts WHERE id = ?").get(Number(info.lastInsertRowid)) as unknown as Alert;
      created.push(row);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  return { created, all: listAlerts(db, profileId) };
}

export function listAlerts(db: DatabaseSync, profileId: number): Alert[] {
  const all = db.prepare("SELECT * FROM alerts WHERE profile_id = ?").all(profileId) as unknown as Alert[];
  all.sort((a, b) => {
    const ackA = a.acknowledged_at ? 1 : 0;
    const ackB = b.acknowledged_at ? 1 : 0;
    if (ackA !== ackB) return ackA - ackB;
    const sevDiff =
      (SEVERITY_RANK[a.severity as Severity] ?? 3) - (SEVERITY_RANK[b.severity as Severity] ?? 3);
    if (sevDiff !== 0) return sevDiff;
    return b.created_at.localeCompare(a.created_at);
  });
  return all;
}
