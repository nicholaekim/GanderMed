// DEMONSTRATION EXPOSURE PROFILES — NOT CLINICAL PHARMACOKINETICS.
//
// v2 (half-life aware): each profile now carries a typical adult elimination
// half-life (immediate-release, healthy adult) and states the BASIS for its
// active window:
//
//   - "half_life":       active_window_hours = round(5 × t½) — the standard
//                        washout convention (~97% eliminated). Deliberately
//                        conservative for overlap detection: a drug counts as
//                        "present" until it is essentially gone, which errs
//                        toward flagging overlap, never toward reassurance.
//   - "effect_duration": the clinical effect outlasts (or is defined
//                        independently of) plasma elimination — e.g.
//                        aspirin's irreversible antiplatelet effect,
//                        warfarin's clotting-factor synthesis, label-defined
//                        nitrate-separation windows. The window models the
//                        EFFECT; the note must explain why.
//
// Real kinetics vary with dose, age, kidney/liver function, genetics
// (CYP2D6 poor metabolizers, etc.), and formulation. A pharmacist must
// review these values before any public release.
//
// max_daily_mg is only set where a well-known OTC self-care label limit
// exists; null means "no limit claimed by this app" (never "no limit").
// Extended-release products are excluded from window modeling upstream.
export const EXPOSURE_VERSION = "exposure-demo-2026.07.2";

export type WindowBasis = "half_life" | "effect_duration";

export interface IngredientProfile {
  /** Typical adult elimination half-life in hours (immediate release). */
  half_life_hours: number;
  window_basis: WindowBasis;
  /** For "half_life" this MUST equal round(5 × t½) — enforced by test. */
  active_window_hours: number;
  max_daily_mg: number | null;
  note: string | null;
}

export const INGREDIENT_PROFILES: Record<string, IngredientProfile> = {
  // OTC analgesics / cold & flu
  acetaminophen: { half_life_hours: 2.5, window_basis: "half_life", active_window_hours: 13, max_daily_mg: 4000, note: "Label max for healthy adults; guidance is often 3000 mg or less with regular use, alcohol, or liver conditions." },
  ibuprofen: { half_life_hours: 2, window_basis: "half_life", active_window_hours: 10, max_daily_mg: 1200, note: "OTC self-care limit; prescribers may direct higher doses." },
  naproxen: { half_life_hours: 14, window_basis: "half_life", active_window_hours: 70, max_daily_mg: 440, note: "OTC self-care limit; prescribers may direct higher doses. Long half-life — remains in the body for days." },
  aspirin: { half_life_hours: 3, window_basis: "effect_duration", active_window_hours: 120, max_daily_mg: 4000, note: "Salicylate is cleared in hours, but aspirin's antiplatelet effect is irreversible — platelets recover over ~7–10 days. The window models the bleeding-relevant effect, not the drug level. Low-dose cardiac aspirin is a different context." },
  diphenhydramine: { half_life_hours: 6, window_basis: "half_life", active_window_hours: 30, max_daily_mg: 300, note: "Half-life is longer in older adults." },
  dimenhydrinate: { half_life_hours: 6, window_basis: "half_life", active_window_hours: 30, max_daily_mg: 400, note: "Delivers diphenhydramine." },
  doxylamine: { half_life_hours: 10, window_basis: "half_life", active_window_hours: 50, max_daily_mg: null, note: null },
  chlorpheniramine: { half_life_hours: 20, window_basis: "half_life", active_window_hours: 100, max_daily_mg: 24, note: "Unusually long half-life for an OTC antihistamine." },
  dextromethorphan: { half_life_hours: 3.5, window_basis: "half_life", active_window_hours: 18, max_daily_mg: 120, note: "CYP2D6 poor metabolizers clear it far more slowly." },
  pseudoephedrine: { half_life_hours: 6, window_basis: "half_life", active_window_hours: 30, max_daily_mg: 240, note: null },
  phenylephrine: { half_life_hours: 2.5, window_basis: "half_life", active_window_hours: 13, max_daily_mg: 60, note: null },
  caffeine: { half_life_hours: 5, window_basis: "half_life", active_window_hours: 25, max_daily_mg: 400, note: "General healthy-adult guidance." },

  // Anticoagulant / chronic meds
  warfarin: { half_life_hours: 40, window_basis: "effect_duration", active_window_hours: 120, max_daily_mg: null, note: "The anticoagulant effect depends on clotting-factor turnover and persists days after the drug itself is cleared; INR normalizes over ~2–5 days after stopping." },
  digoxin: { half_life_hours: 38, window_basis: "half_life", active_window_hours: 190, max_daily_mg: null, note: "Washout takes about a week; longer with reduced kidney function." },
  lithium: { half_life_hours: 24, window_basis: "half_life", active_window_hours: 120, max_daily_mg: null, note: "Strongly dependent on kidney function and hydration." },
  sertraline: { half_life_hours: 26, window_basis: "half_life", active_window_hours: 130, max_daily_mg: null, note: null },
  fluoxetine: { half_life_hours: 96, window_basis: "effect_duration", active_window_hours: 480, max_daily_mg: null, note: "Parent half-life is ~1–4 days, but the active metabolite norfluoxetine persists 4–16 days — true washout is measured in weeks." },
  paroxetine: { half_life_hours: 21, window_basis: "half_life", active_window_hours: 105, max_daily_mg: null, note: null },
  escitalopram: { half_life_hours: 30, window_basis: "half_life", active_window_hours: 150, max_daily_mg: null, note: null },
  citalopram: { half_life_hours: 35, window_basis: "half_life", active_window_hours: 175, max_daily_mg: null, note: null },
  venlafaxine: { half_life_hours: 11, window_basis: "half_life", active_window_hours: 55, max_daily_mg: null, note: "Includes the active metabolite desvenlafaxine." },
  duloxetine: { half_life_hours: 12, window_basis: "half_life", active_window_hours: 60, max_daily_mg: null, note: null },
  trazodone: { half_life_hours: 7, window_basis: "half_life", active_window_hours: 35, max_daily_mg: null, note: null },

  // Opioids (immediate-release; no max claimed — prescription-specific)
  oxycodone: { half_life_hours: 3.5, window_basis: "half_life", active_window_hours: 18, max_daily_mg: null, note: null },
  hydrocodone: { half_life_hours: 4, window_basis: "half_life", active_window_hours: 20, max_daily_mg: null, note: null },
  morphine: { half_life_hours: 3, window_basis: "half_life", active_window_hours: 15, max_daily_mg: null, note: null },
  codeine: { half_life_hours: 3, window_basis: "half_life", active_window_hours: 15, max_daily_mg: null, note: null },
  hydromorphone: { half_life_hours: 2.5, window_basis: "half_life", active_window_hours: 13, max_daily_mg: null, note: null },
  tramadol: { half_life_hours: 6.3, window_basis: "half_life", active_window_hours: 32, max_daily_mg: 400, note: "Typical adult maximum; prescription-specific. Active metabolite half-life is slightly longer." },

  // Benzodiazepines & sleep aids
  alprazolam: { half_life_hours: 11, window_basis: "half_life", active_window_hours: 55, max_daily_mg: null, note: null },
  lorazepam: { half_life_hours: 12, window_basis: "half_life", active_window_hours: 60, max_daily_mg: null, note: null },
  diazepam: { half_life_hours: 48, window_basis: "half_life", active_window_hours: 240, max_daily_mg: null, note: "Half-life 20–100 h, and the active metabolite nordiazepam persists even longer — washout takes well over a week." },
  clonazepam: { half_life_hours: 35, window_basis: "half_life", active_window_hours: 175, max_daily_mg: null, note: null },
  temazepam: { half_life_hours: 9, window_basis: "half_life", active_window_hours: 45, max_daily_mg: null, note: null },
  oxazepam: { half_life_hours: 7, window_basis: "half_life", active_window_hours: 35, max_daily_mg: null, note: null },
  zopiclone: { half_life_hours: 5, window_basis: "half_life", active_window_hours: 25, max_daily_mg: null, note: null },
  zolpidem: { half_life_hours: 2.5, window_basis: "half_life", active_window_hours: 13, max_daily_mg: null, note: null },

  // ED meds & nitrates — the overlap timing here is the classic danger case
  sildenafil: { half_life_hours: 4, window_basis: "effect_duration", active_window_hours: 24, max_daily_mg: null, note: "Product labels advise separating nitrates by at least 24 h — the window follows the label, which is wider than 5 half-lives." },
  vardenafil: { half_life_hours: 4.5, window_basis: "effect_duration", active_window_hours: 24, max_daily_mg: null, note: "Product labels advise separating nitrates by at least 24 h — the window follows the label, which is wider than 5 half-lives." },
  tadalafil: { half_life_hours: 17.5, window_basis: "half_life", active_window_hours: 88, max_daily_mg: null, note: "Long half-life; labels advise at least 48 h before nitrates, and full washout is closer to 4 days." },
  nitroglycerin: { half_life_hours: 0.05, window_basis: "effect_duration", active_window_hours: 2, max_daily_mg: null, note: "Plasma half-life is ~3 minutes; the window covers the hemodynamic effect of a dosing episode." },
};
