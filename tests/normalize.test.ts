// Golden cases for ingredient normalization — the layer every safety check
// depends on. A wrong canonical name means a silently missed interaction.

import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalIngredient, detectExtendedRelease } from "../src/lib/normalize";

test("salt forms are stripped to the active moiety", () => {
  assert.equal(canonicalIngredient("WARFARIN SODIUM"), "warfarin");
  assert.equal(canonicalIngredient("CODEINE PHOSPHATE"), "codeine");
  assert.equal(canonicalIngredient("METOPROLOL TARTRATE"), "metoprolol");
  assert.equal(canonicalIngredient("METFORMIN HYDROCHLORIDE"), "metformin");
  assert.equal(canonicalIngredient("DILTIAZEM HYDROCHLORIDE"), "diltiazem");
  assert.equal(canonicalIngredient("ESOMEPRAZOLE MAGNESIUM"), "esomeprazole");
  assert.equal(canonicalIngredient("DICLOFENAC POTASSIUM"), "diclofenac");
  assert.equal(canonicalIngredient("LEVOTHYROXINE SODIUM"), "levothyroxine");
});

test("Canadian synonyms map to ruleset canonical names", () => {
  assert.equal(canonicalIngredient("ACETYLSALICYLIC ACID"), "aspirin");
  assert.equal(canonicalIngredient("LITHIUM CARBONATE"), "lithium");
  assert.equal(canonicalIngredient("PARACETAMOL"), "acetaminophen");
  assert.equal(canonicalIngredient("GLYCERYL TRINITRATE"), "nitroglycerin");
});

test("mineral compounds are NEVER salt-stripped (KEEP_AS_IS)", () => {
  // Stripping these would change the substance entirely:
  // "ferrous sulfate" -> "ferrous" would break the levothyroxine rule.
  assert.equal(canonicalIngredient("FERROUS SULFATE"), "ferrous sulfate");
  assert.equal(canonicalIngredient("CALCIUM CARBONATE"), "calcium carbonate");
  assert.equal(canonicalIngredient("POTASSIUM CHLORIDE"), "potassium chloride");
  assert.equal(canonicalIngredient("MAGNESIUM HYDROXIDE"), "magnesium hydroxide");
});

test("parentheticals and casing are normalized", () => {
  assert.equal(canonicalIngredient("IBUPROFEN (IBUPROFEN LYSINE)"), "ibuprofen");
  assert.equal(canonicalIngredient("  Ibuprofen  "), "ibuprofen");
  assert.equal(canonicalIngredient("ACETAMINOPHEN"), "acetaminophen");
});

test("extended-release products are detected from brand/form names", () => {
  assert.equal(detectExtendedRelease("TIAZAC", "Capsule (Extended Release)"), true);
  assert.equal(detectExtendedRelease("WELLBUTRIN XL", "Tablet"), true);
  assert.equal(detectExtendedRelease("SOME BRAND 12 HOUR", null), true);
  assert.equal(detectExtendedRelease("MS CONTIN", "Tablet"), true);
  assert.equal(detectExtendedRelease("ADVIL", "Tablet"), false);
  assert.equal(detectExtendedRelease("SYNTHROID", "Tablet"), false);
});
