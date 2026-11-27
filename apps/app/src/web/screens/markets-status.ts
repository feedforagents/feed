import type { PredictionMarketRow } from "@repo/ui";

export function toPredictionStatus(raw: string): PredictionMarketRow["status"] {
  const lower = raw.toLowerCase();
  if (lower === "resolved") return "resolved";
  if (lower === "cancelled") return "cancelled";
  if (lower === "expired" || lower === "awaiting_proof" || lower === "manual_hold") return "expired";
  return "active";
}
