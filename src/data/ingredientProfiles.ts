// DEMONSTRATION EXPOSURE PROFILES — NOT CLINICAL PHARMACOKINETICS.
// active_window_hours is a rough "estimated exposure window" for an
// immediate-release dose in a typical adult: long enough to reason about
// overlap, deliberately NOT a concentration model. Real duration varies with
// formulation, dose, age, kidney/liver function, and genetics. A pharmacist
// must review these values before any public release.
//
// max_daily_mg is only set where a well-known OTC self-care label limit
// exists; null means "no limit claimed by this app" (never "no limit").
// Extended-release products are excluded from window modeling upstream.
export const EXPOSURE_VERSION = "exposure-demo-2026.07.1";

export interface IngredientProfile {
  active_window_hours: number;
  max_daily_mg: number | null;
  note: string | null;
}

export const INGREDIENT_PROFILES: Record<string, IngredientProfile> = {
  // OTC analgesics / cold & flu
  acetaminophen: { active_window_hours: 6, max_daily_mg: 4000, note: "Label max for healthy adults; guidance is often 3000 mg or less with regular use, alcohol, or liver conditions." },
  ibuprofen: { active_window_hours: 8, max_daily_mg: 1200, note: "OTC self-care limit; prescribers may direct higher doses." },
  naproxen: { active_window_hours: 12, max_daily_mg: 440, note: "OTC self-care limit; prescribers may direct higher doses." },
  aspirin: { active_window_hours: 6, max_daily_mg: 4000, note: "Analgesic dosing; low-dose cardiac aspirin is a different context." },
  diphenhydramine: { active_window_hours: 8, max_daily_mg: 300, note: null },
  dimenhydrinate: { active_window_hours: 8, max_daily_mg: 400, note: null },
  doxylamine: { active_window_hours: 10, max_daily_mg: null, note: null },
  chlorpheniramine: { active_window_hours: 8, max_daily_mg: 24, note: null },
  dextromethorphan: { active_window_hours: 8, max_daily_mg: 120, note: null },
  pseudoephedrine: { active_window_hours: 12, max_daily_mg: 240, note: null },
  phenylephrine: { active_window_hours: 4, max_daily_mg: 60, note: null },
  caffeine: { active_window_hours: 6, max_daily_mg: 400, note: "General healthy-adult guidance." },

  // Anticoagulant / chronic meds modeled as effectively continuous while taken
  warfarin: { active_window_hours: 48, max_daily_mg: null, note: "Long-acting: treated as active between daily doses." },
  digoxin: { active_window_hours: 48, max_daily_mg: null, note: "Long-acting: treated as active between daily doses." },
  lithium: { active_window_hours: 24, max_daily_mg: null, note: null },
  sertraline: { active_window_hours: 48, max_daily_mg: null, note: "Chronic antidepressant: treated as continuously active while taken." },
  fluoxetine: { active_window_hours: 96, max_daily_mg: null, note: "Very long-acting antidepressant." },
  paroxetine: { active_window_hours: 48, max_daily_mg: null, note: "Chronic antidepressant: treated as continuously active while taken." },
  escitalopram: { active_window_hours: 48, max_daily_mg: null, note: "Chronic antidepressant: treated as continuously active while taken." },
  citalopram: { active_window_hours: 48, max_daily_mg: null, note: "Chronic antidepressant: treated as continuously active while taken." },
  venlafaxine: { active_window_hours: 24, max_daily_mg: null, note: null },
  duloxetine: { active_window_hours: 24, max_daily_mg: null, note: null },
  trazodone: { active_window_hours: 12, max_daily_mg: null, note: null },

  // Opioids (immediate-release estimates; no max claimed — prescription-specific)
  oxycodone: { active_window_hours: 6, max_daily_mg: null, note: null },
  hydrocodone: { active_window_hours: 6, max_daily_mg: null, note: null },
  morphine: { active_window_hours: 5, max_daily_mg: null, note: null },
  codeine: { active_window_hours: 6, max_daily_mg: null, note: null },
  hydromorphone: { active_window_hours: 5, max_daily_mg: null, note: null },
  tramadol: { active_window_hours: 8, max_daily_mg: 400, note: "Typical adult maximum; prescription-specific." },

  // Benzodiazepines & sleep aids
  alprazolam: { active_window_hours: 12, max_daily_mg: null, note: null },
  lorazepam: { active_window_hours: 12, max_daily_mg: null, note: null },
  diazepam: { active_window_hours: 48, max_daily_mg: null, note: "Long-acting." },
  clonazepam: { active_window_hours: 24, max_daily_mg: null, note: null },
  temazepam: { active_window_hours: 12, max_daily_mg: null, note: null },
  oxazepam: { active_window_hours: 12, max_daily_mg: null, note: null },
  zopiclone: { active_window_hours: 8, max_daily_mg: null, note: null },
  zolpidem: { active_window_hours: 6, max_daily_mg: null, note: null },

  // ED meds & nitrates — the overlap timing here is the classic danger case
  sildenafil: { active_window_hours: 24, max_daily_mg: null, note: "Nitrates are contraindicated within ~24 h of a dose." },
  vardenafil: { active_window_hours: 24, max_daily_mg: null, note: "Nitrates are contraindicated within ~24 h of a dose." },
  tadalafil: { active_window_hours: 48, max_daily_mg: null, note: "Nitrates are contraindicated within ~48 h of a dose." },
  nitroglycerin: { active_window_hours: 2, max_daily_mg: null, note: null },
};
