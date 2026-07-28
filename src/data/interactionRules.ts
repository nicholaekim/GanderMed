import type { Evidence, Severity } from "@/lib/types";

// DEMONSTRATION RULESET — NOT A LICENSED CLINICAL DATABASE.
// Hand-compiled from publicly documented interaction warnings (product
// monographs and public interaction references) to prove the workflow.
// Before any public launch this must be replaced by a licensed clinical
// interaction API (DrugBank Clinical, Medi-Span, FDB, Lexidrug) and the
// full workflow validated by a pharmacist. Severities here are intentionally
// conservative and every alert routes the user to a professional.
export const RULESET_VERSION = "demo-2026.07.1";
export const RULESET_SOURCE =
  "Demonstration ruleset compiled from public product-monograph interaction warnings";

export const MAJOR_ACTION =
  "Contact your pharmacist or prescriber before your next dose. Do not stop a prescribed medication on your own — stopping suddenly can also be dangerous.";
export const MODERATE_ACTION =
  "Mention this combination to your pharmacist. Monitoring, spacing doses apart, or an alternative may be recommended.";
export const MINOR_ACTION =
  "Usually manageable. Ask your pharmacist if you notice new or unusual side effects.";
const SEPARATE_ACTION =
  "Take these at least 4 hours apart. Confirm the best schedule with your pharmacist.";

interface RuleGroup {
  a: string[];
  b: string[];
  severity: Severity;
  evidence: Evidence;
  mechanism: string;
  action?: string;
}

const NSAIDS = ["ibuprofen", "naproxen", "aspirin", "diclofenac", "meloxicam", "ketorolac", "celecoxib", "indomethacin", "ketoprofen"];
const OPIOIDS = ["oxycodone", "hydrocodone", "morphine", "codeine", "fentanyl", "hydromorphone", "methadone", "tramadol", "tapentadol"];
const BENZOS = ["alprazolam", "diazepam", "lorazepam", "clonazepam", "temazepam", "oxazepam"];
const Z_DRUGS = ["zopiclone", "zolpidem", "eszopiclone"];
const SSRI_SNRI = ["sertraline", "fluoxetine", "paroxetine", "escitalopram", "citalopram", "fluvoxamine", "venlafaxine", "desvenlafaxine", "duloxetine", "trazodone"];
const SSRIS = ["sertraline", "fluoxetine", "paroxetine", "escitalopram", "citalopram", "fluvoxamine"];
const MAOIS = ["phenelzine", "tranylcypromine", "moclobemide", "selegiline"];
const NITRATES = ["nitroglycerin", "isosorbide mononitrate", "isosorbide dinitrate"];
const PDE5 = ["sildenafil", "tadalafil", "vardenafil"];
const STATINS_SENSITIVE = ["simvastatin", "lovastatin"];
const CYP3A4_BLOCKERS = ["clarithromycin", "erythromycin", "itraconazole", "ketoconazole"];
const ACEI_ARB = ["lisinopril", "ramipril", "enalapril", "perindopril", "losartan", "valsartan", "candesartan", "irbesartan", "telmisartan"];
const K_SPARING = ["spironolactone", "eplerenone", "amiloride", "potassium chloride"];
const SEDATING_ANTIHISTAMINES = ["diphenhydramine", "doxylamine", "dimenhydrinate", "hydroxyzine", "chlorpheniramine"];
const BETA_BLOCKERS = ["metoprolol", "bisoprolol", "atenolol", "carvedilol", "propranolol"];
const NON_DHP_CCB = ["verapamil", "diltiazem"];
const IRON_CALCIUM = ["calcium carbonate", "calcium citrate", "ferrous sulfate", "ferrous gluconate", "ferrous fumarate"];
const TETRACYCLINES = ["doxycycline", "minocycline", "tetracycline"];
const DECONGESTANTS = ["pseudoephedrine", "phenylephrine"];

const RULE_GROUPS: RuleGroup[] = [
  {
    a: ["warfarin"], b: NSAIDS, severity: "major", evidence: "high",
    mechanism: "Taking an anti-inflammatory (NSAID) with warfarin greatly increases the risk of serious bleeding, including stomach bleeding.",
  },
  {
    a: ["warfarin"], b: ["fluconazole", "metronidazole", "sulfamethoxazole", "trimethoprim", "clarithromycin", "erythromycin", "ciprofloxacin", "amiodarone"],
    severity: "major", evidence: "high",
    mechanism: "This medication can raise warfarin levels in the blood (higher INR), which increases the risk of dangerous bleeding.",
  },
  {
    a: ["warfarin"], b: ["acetaminophen"], severity: "minor", evidence: "moderate",
    mechanism: "Regular high-dose acetaminophen can modestly increase warfarin's blood-thinning effect. Occasional normal doses are usually fine.",
  },
  {
    a: PDE5, b: NITRATES, severity: "major", evidence: "high",
    mechanism: "Erectile-dysfunction medications combined with nitrates can cause a sudden, dangerous drop in blood pressure.",
  },
  {
    a: OPIOIDS, b: BENZOS, severity: "major", evidence: "high",
    mechanism: "Opioid pain medication combined with benzodiazepines can cause deep sedation and dangerously slowed breathing.",
  },
  {
    a: OPIOIDS, b: Z_DRUGS, severity: "major", evidence: "high",
    mechanism: "Opioid pain medication combined with sleep medication can cause deep sedation and dangerously slowed breathing.",
  },
  {
    a: ["tramadol"], b: SSRI_SNRI, severity: "major", evidence: "moderate",
    mechanism: "Tramadol with serotonergic antidepressants raises the risk of serotonin syndrome (agitation, fever, tremor) and can lower the seizure threshold.",
  },
  {
    a: MAOIS, b: SSRI_SNRI, severity: "major", evidence: "high",
    mechanism: "MAO inhibitors with serotonergic antidepressants can cause serotonin syndrome, which can be life-threatening. These are usually never combined.",
  },
  {
    a: MAOIS, b: DECONGESTANTS, severity: "major", evidence: "high",
    mechanism: "Decongestants (found in many cold products) with MAO inhibitors can cause a dangerous spike in blood pressure.",
  },
  {
    a: ["dextromethorphan"], b: SSRIS, severity: "moderate", evidence: "moderate",
    mechanism: "Cough suppressant dextromethorphan with SSRIs can add to serotonin effects, especially at high doses.",
  },
  {
    a: SSRIS, b: NSAIDS, severity: "moderate", evidence: "high",
    mechanism: "SSRIs combined with anti-inflammatories (NSAIDs) increase the risk of stomach and intestinal bleeding.",
  },
  {
    a: STATINS_SENSITIVE, b: CYP3A4_BLOCKERS, severity: "major", evidence: "high",
    mechanism: "This antibiotic/antifungal blocks the breakdown of the statin, which can lead to severe muscle damage (rhabdomyolysis).",
  },
  {
    a: ["atorvastatin"], b: ["clarithromycin", "itraconazole"], severity: "moderate", evidence: "moderate",
    mechanism: "This medication raises atorvastatin levels, increasing the chance of muscle pain or damage.",
  },
  {
    a: ["domperidone"], b: CYP3A4_BLOCKERS, severity: "major", evidence: "high",
    mechanism: "This combination raises domperidone levels and the risk of serious heart-rhythm problems (QT prolongation).",
  },
  {
    a: ACEI_ARB, b: K_SPARING, severity: "moderate", evidence: "high",
    mechanism: "Blood-pressure medication combined with potassium-sparing medication or potassium supplements can push blood potassium dangerously high.",
  },
  {
    a: ["methotrexate"], b: NSAIDS, severity: "major", evidence: "high",
    mechanism: "Anti-inflammatories (NSAIDs) can reduce methotrexate clearance, raising it to toxic levels.",
  },
  {
    a: ["lithium"], b: NSAIDS, severity: "moderate", evidence: "high",
    mechanism: "Anti-inflammatories (NSAIDs) can raise lithium levels, which has a narrow safety margin.",
  },
  {
    a: ["lithium"], b: ACEI_ARB, severity: "moderate", evidence: "high",
    mechanism: "Blood-pressure medications of this type can raise lithium levels, which has a narrow safety margin.",
  },
  {
    a: ["ciprofloxacin"], b: ["tizanidine"], severity: "major", evidence: "high",
    mechanism: "Ciprofloxacin dramatically raises tizanidine levels, causing severe drowsiness and low blood pressure. This combination is contraindicated.",
  },
  {
    a: ["clopidogrel"], b: ["omeprazole", "esomeprazole"], severity: "moderate", evidence: "moderate",
    mechanism: "These acid reducers can weaken clopidogrel's protection against blood clots.",
  },
  {
    a: ["digoxin"], b: ["amiodarone", "clarithromycin"], severity: "major", evidence: "high",
    mechanism: "This medication raises digoxin levels, which can cause nausea, vision changes, and dangerous heart-rhythm problems.",
  },
  {
    a: ["digoxin"], b: ["verapamil"], severity: "moderate", evidence: "high",
    mechanism: "Verapamil raises digoxin levels; doses often need adjusting and levels monitoring.",
  },
  {
    a: ["levothyroxine"], b: IRON_CALCIUM, severity: "moderate", evidence: "high",
    mechanism: "Calcium and iron bind levothyroxine in the gut and block its absorption, making thyroid treatment less effective.",
    action: SEPARATE_ACTION,
  },
  {
    a: NON_DHP_CCB, b: BETA_BLOCKERS, severity: "moderate", evidence: "high",
    mechanism: "These two types of heart medication together can slow the heart rate too much.",
  },
  {
    a: ["prednisone"], b: NSAIDS, severity: "moderate", evidence: "high",
    mechanism: "Corticosteroids with anti-inflammatories (NSAIDs) increase the risk of stomach ulcers and bleeding.",
  },
  {
    a: NSAIDS, b: NSAIDS, severity: "moderate", evidence: "high",
    mechanism: "Two anti-inflammatories (NSAIDs) taken together add up: more risk of stomach bleeding and kidney strain with no extra benefit.",
  },
  {
    a: SEDATING_ANTIHISTAMINES, b: [...OPIOIDS, ...BENZOS, ...Z_DRUGS], severity: "moderate", evidence: "moderate",
    mechanism: "Sedating antihistamines (found in many sleep and cold products) add to the drowsiness caused by this medication.",
  },
  {
    a: SEDATING_ANTIHISTAMINES, b: SEDATING_ANTIHISTAMINES, severity: "moderate", evidence: "moderate",
    mechanism: "Two sedating antihistamines together add up to more drowsiness, dry mouth, and confusion — often unintentionally via cold or sleep products.",
  },
  {
    a: ["citalopram", "escitalopram"], b: ["ondansetron", "azithromycin", "domperidone"], severity: "moderate", evidence: "moderate",
    mechanism: "Both medications can affect heart rhythm (QT prolongation); the effect can add up.",
  },
  {
    a: ["isotretinoin"], b: TETRACYCLINES, severity: "major", evidence: "moderate",
    mechanism: "Acne medication isotretinoin with tetracycline antibiotics increases the risk of raised pressure around the brain (intracranial hypertension).",
  },
  {
    a: ["amlodipine"], b: ["simvastatin"], severity: "minor", evidence: "moderate",
    mechanism: "Amlodipine modestly raises simvastatin levels; simvastatin doses are usually capped when combined.",
  },
];

export interface ExpandedRule {
  ingredient_a: string;
  ingredient_b: string;
  severity: Severity;
  evidence: Evidence;
  mechanism: string;
  recommended_action: string;
}

const SEVERITY_RANK: Record<Severity, number> = { major: 0, moderate: 1, minor: 2 };

const DEFAULT_ACTIONS: Record<Severity, string> = {
  major: MAJOR_ACTION,
  moderate: MODERATE_ACTION,
  minor: MINOR_ACTION,
};

// Expands class-level rule groups into unique ingredient pairs. When two
// groups produce the same pair, the more severe rule wins.
export function expandRules(): ExpandedRule[] {
  const drafts: ExpandedRule[] = [];
  for (const g of RULE_GROUPS) {
    for (const rawA of g.a) {
      for (const rawB of g.b) {
        if (rawA === rawB) continue;
        const [a, b] = [rawA, rawB].sort();
        drafts.push({
          ingredient_a: a,
          ingredient_b: b,
          severity: g.severity,
          evidence: g.evidence,
          mechanism: g.mechanism,
          recommended_action: g.action ?? DEFAULT_ACTIONS[g.severity],
        });
      }
    }
  }
  drafts.sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity]);
  const seen = new Set<string>();
  const unique: ExpandedRule[] = [];
  for (const d of drafts) {
    const key = `${d.ingredient_a}|${d.ingredient_b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(d);
  }
  return unique;
}

// Ingredients where taking the same substance from two products is
// especially dangerous, not just wasteful.
export const DUPLICATE_MAJOR = new Set<string>([
  "acetaminophen", "warfarin", "lithium", "methotrexate", ...OPIOIDS,
]);
