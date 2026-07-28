// Deterministic pharmacist-question generator (client-safe, no Node imports).
// Generates precise questions from the structured alert — never advice.

import type { Alert } from "@/lib/types";
import { titleCase } from "@/lib/normalize";

export function pharmacistQuestions(a: Alert): string[] {
  const medA = titleCase(a.med_a_name);
  const medB = titleCase(a.med_b_name);
  const ing = titleCase(a.ingredient_a);

  if (a.kind === "duplicate") {
    return [
      `${medA} and ${medB} both contain ${ing} — what total daily amount is safe for me?`,
      `Should I keep taking both products, or drop one?`,
      `What symptoms of getting too much ${ing} should I watch for?`,
    ];
  }

  const qs = [
    `Is taking ${medA} and ${medB} together intentional for me?`,
    `Should the doses be separated in time — and by how much?`,
    a.severity === "major"
      ? `What warning signs with this combination mean I need urgent care?`
      : `What side effects would suggest this combination is affecting me?`,
    `Does my dose or anything in my health history make this more or less risky?`,
  ];
  return qs;
}
