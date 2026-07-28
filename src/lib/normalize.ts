// Canonicalizes ingredient names so DPD product listings ("WARFARIN SODIUM",
// "CODEINE PHOSPHATE") match the interaction ruleset ("warfarin", "codeine").
// Interactions belong to the active moiety, not the salt form.

// Compound names where the trailing word is chemistry, not a salt suffix —
// stripping it would change the substance ("ferrous sulfate" -> "ferrous").
const KEEP_AS_IS = new Set([
  "calcium carbonate",
  "calcium citrate",
  "potassium chloride",
  "ferrous sulfate",
  "ferrous gluconate",
  "ferrous fumarate",
  "magnesium sulfate",
  "magnesium oxide",
  "magnesium hydroxide",
  "magnesium citrate",
  "sodium chloride",
  "sodium bicarbonate",
  "zinc sulfate",
]);

const SALT_SUFFIXES = new Set([
  "hydrochloride", "dihydrochloride", "hcl", "hydrobromide", "bromide",
  "sodium", "potassium", "calcium", "magnesium",
  "tartrate", "bitartrate", "citrate", "sulfate", "sulphate",
  "maleate", "fumarate", "succinate", "mesylate", "besylate", "tosylate",
  "phosphate", "diphosphate", "acetate", "propionate", "dipropionate",
  "valerate", "decanoate", "palmitate",
  "monohydrate", "dihydrate", "trihydrate", "hemihydrate", "sesquihydrate",
  "anhydrous", "micronized", "usp",
]);

// Canadian labels sometimes use a different name than the ruleset's canonical key.
const SYNONYMS: Record<string, string> = {
  "acetylsalicylic acid": "aspirin",
  "asa": "aspirin",
  "paracetamol": "acetaminophen",
  "glyceryl trinitrate": "nitroglycerin",
  "lithium carbonate": "lithium",
  "lithium citrate": "lithium",
  "salbutamol": "albuterol",
};

export function canonicalIngredient(raw: string): string {
  let name = raw
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (SYNONYMS[name]) name = SYNONYMS[name];
  if (KEEP_AS_IS.has(name)) return name;

  let tokens = name.split(" ");
  while (tokens.length > 1 && SALT_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens = tokens.slice(0, -1);
    const joined = tokens.join(" ");
    if (SYNONYMS[joined]) return SYNONYMS[joined];
    if (KEEP_AS_IS.has(joined)) return joined;
  }
  const result = tokens.join(" ");
  return SYNONYMS[result] ?? result;
}

// Extended-release products keep the same ingredients (so rolling mg totals
// still count) but their exposure window can't be estimated with the
// immediate-release profile — window modeling is disabled for them.
const ER_PATTERN =
  /\b(?:12|24)[- ]?(?:hour|hr|h)\b|extended[- ]release|sustained[- ]release|slow[- ]release|controlled[- ]release|long[- ]acting|prolonged[- ]release|\b(?:xr|er|sr|cr|la|xl)\b|contin\b/i;

export function detectExtendedRelease(brandName: string, dosageForm: string | null): boolean {
  return ER_PATTERN.test(`${brandName} ${dosageForm ?? ""}`);
}

export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(" ")
    .map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ")
    .replace(/^\w/, (c) => c.toUpperCase());
}
