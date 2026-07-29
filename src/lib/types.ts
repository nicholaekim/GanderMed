export type Severity = "major" | "moderate" | "minor";
export type Evidence = "high" | "moderate" | "low";

export interface ProductIngredient {
  id: number;
  medication_id: number;
  ingredient_name: string;
  canonical_name: string;
  strength: string | null;
  strength_unit: string | null;
}

/** Patient-reported "how I actually take this" — provenance, never a safety signal. */
export type ActualUse = "taking" | "not_taking" | "taking_differently" | "recently_stopped" | "unsure";

export const ACTUAL_USE_LABELS: Record<ActualUse, string> = {
  taking: "Taking as listed",
  not_taking: "Not taking this",
  taking_differently: "Taking it differently",
  recently_stopped: "Recently stopped",
  unsure: "Not sure",
};

export interface Medication {
  id: number;
  profile_id: number;
  drug_code: number | null;
  din: string | null;
  brand_name: string;
  company_name: string | null;
  route: string | null;
  dosage_form: string | null;
  verified: number;
  is_extended_release: number;
  dose_value: number | null;
  dose_unit: string | null;
  is_prn: number;
  schedule_times: string;
  start_date: string | null;
  end_date: string | null;
  instructions: string | null;
  status: "active" | "stopped";
  actual_use: ActualUse;
  patient_notes: string | null;
  created_at: string;
  ingredients: ProductIngredient[];
}

export interface DoseEvent {
  id: number;
  medication_id: number;
  brand_name?: string;
  scheduled_at: string | null;
  logged_at: string;
  status: "taken" | "skipped" | "late";
  dose_value: number | null;
  dose_unit: string | null;
}

export type AlertKind = "interaction" | "duplicate";

export type ExposureStatus = "overlap" | "no_overlap" | "insufficient_data" | "unknown";

export interface Alert {
  id: number;
  profile_id: number;
  kind: AlertKind;
  severity: Severity;
  evidence: Evidence;
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
  created_at: string;
  acknowledged_at: string | null;
  /** Computed at read time, not stored: is this alert about ingredients estimated active right now? */
  exposure_status?: ExposureStatus;
  /** Active clinician review for this exact combination, attached at read time. */
  review?: AlertReview | null;
}

export interface AlertReview {
  id: number;
  note: string;
  reviewer_name: string;
  reviewer_clinic: string | null;
  created_at: string;
  expires_at: string;
}

export interface ExposureSourceDose {
  brand_name: string;
  at: string;
  mg: number | null;
}

export interface RollingTotal {
  ingredient: string;
  total_mg: number;
  max_daily_mg: number | null;
  over: boolean;
  note: string | null;
  sources: ExposureSourceDose[];
  uncounted: { brand_name: string; at: string; reason: string }[];
}

export interface ActiveIngredient {
  ingredient: string;
  until: string;
  sources: { brand_name: string; until: string }[];
}

export interface ExposureReport {
  computed_at: string;
  version: string;
  active_now: ActiveIngredient[];
  totals: RollingTotal[];
}

export interface Me {
  id: number;
  email: string;
  display_name: string;
  role: "patient" | "clinician";
  clinic_name: string | null;
  profile_id: number | null;
  share_code: string | null;
}

export interface RosterEntry {
  grant_id: number;
  profile_id: number;
  patient_name: string;
  patient_email: string | null;
  purpose: string | null;
  expires_at: string | null;
  active_medications: number;
  alerts_major: number;
  alerts_moderate: number;
  alerts_minor: number;
  alerts_reviewed: number;
  alerts_acknowledged: number;
  last_dose_at: string | null;
}

export interface PendingRequest {
  grant_id: number;
  patient_name: string;
  purpose: string | null;
  requested_at: string;
}

export interface AccessGrantView {
  id: number;
  status: "pending" | "active" | "denied" | "revoked" | "expired";
  purpose: string | null;
  requested_at: string;
  decided_at: string | null;
  starts_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  clinician_name: string;
  clinic_name: string | null;
}

export interface AuditEventView {
  at: string;
  action: string;
  actor_name: string | null;
  actor_clinic: string | null;
}

export interface SearchResult {
  drug_code: number;
  din: string;
  brand_name: string;
  company_name: string;
  number_of_ais: number;
}

export interface AddMedicationPayload {
  drug_code?: number;
  din?: string;
  brand_name?: string;
  company_name?: string;
  manual_name?: string;
  dose_value?: number | null;
  dose_unit?: string | null;
  is_prn: boolean;
  schedule_times: string[];
  start_date?: string | null;
  end_date?: string | null;
  instructions?: string | null;
}
