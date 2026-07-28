// Client for Health Canada's Drug Product Database (DPD) API.
// Docs: https://health-products.canada.ca/api/documentation/dpd-documentation-en.html
// Free, no key. Nightly-updated. All calls happen server-side.

import type { SearchResult } from "@/lib/types";

const BASE = "https://health-products.canada.ca/api/drug";

async function dpdFetch<T>(pathAndQuery: string): Promise<T[]> {
  const res = await fetch(`${BASE}/${pathAndQuery}`, {
    signal: AbortSignal.timeout(12000),
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`DPD API ${res.status} for ${pathAndQuery}`);
  const data = (await res.json()) as T | T[] | null;
  if (data == null) return [];
  return Array.isArray(data) ? data : [data];
}

interface DpdProduct {
  drug_code: number;
  class_name: string;
  drug_identification_number: string;
  brand_name: string;
  descriptor: string;
  number_of_ais: string;
  company_name: string;
  last_update_date: string;
}

interface DpdIngredient {
  drug_code: number;
  ingredient_name: string;
  strength: string;
  strength_unit: string;
  dosage_value: string;
  dosage_unit: string;
}

interface DpdRoute { route_of_administration_name: string }
interface DpdForm { pharmaceutical_form_name: string }
interface DpdStatus { status: string }

// status=2 restricts the DPD search to currently marketed products, which
// hides the decades of discontinued variants the API otherwise returns.
export async function searchProducts(query: string): Promise<SearchResult[]> {
  const q = query.trim();
  const isDin = /^\d{6,8}$/.test(q);

  const rows = isDin
    ? await dpdFetch<DpdProduct>(`drugproduct/?din=${q.padStart(8, "0")}&lang=en&type=json`)
    : await dpdFetch<DpdProduct>(`drugproduct/?brandname=${encodeURIComponent(q)}&status=2&lang=en&type=json`);

  const lower = q.toLowerCase();
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const r of rows) {
    if (r.class_name !== "Human") continue;
    if (seen.has(r.drug_identification_number)) continue;
    seen.add(r.drug_identification_number);
    results.push({
      drug_code: r.drug_code,
      din: r.drug_identification_number,
      brand_name: r.brand_name,
      company_name: r.company_name,
      number_of_ais: Number(r.number_of_ais) || 0,
    });
  }
  results.sort((a, b) => {
    const aStarts = a.brand_name.toLowerCase().startsWith(lower) ? 0 : 1;
    const bStarts = b.brand_name.toLowerCase().startsWith(lower) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    return a.brand_name.length - b.brand_name.length;
  });
  return results.slice(0, 15);
}

export interface ProductDetails {
  ingredients: { ingredient_name: string; strength: string | null; strength_unit: string | null }[];
  route: string | null;
  dosage_form: string | null;
  status: string | null;
}

export async function getProductDetails(drugCode: number): Promise<ProductDetails> {
  const [ingredients, routes, forms, statuses] = await Promise.all([
    dpdFetch<DpdIngredient>(`activeingredient/?id=${drugCode}&lang=en&type=json`),
    dpdFetch<DpdRoute>(`route/?id=${drugCode}&lang=en&type=json`).catch(() => []),
    dpdFetch<DpdForm>(`form/?id=${drugCode}&lang=en&type=json`).catch(() => []),
    dpdFetch<DpdStatus>(`status/?id=${drugCode}&lang=en&type=json`).catch(() => []),
  ]);

  return {
    ingredients: ingredients.map((i) => ({
      ingredient_name: i.ingredient_name,
      strength: i.strength || null,
      strength_unit: i.strength_unit || null,
    })),
    route: routes.map((r) => r.route_of_administration_name).filter(Boolean).join(", ") || null,
    dosage_form: forms.map((f) => f.pharmaceutical_form_name).filter(Boolean).join(", ") || null,
    status: statuses[0]?.status ?? null,
  };
}
