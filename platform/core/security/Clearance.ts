/**
 * Generic classification hierarchy, applicable to both corporate
 * (e.g. "internal", "restricted") and defense contexts (e.g.
 * "confidential", "secret") without hardcoding either domain's
 * vocabulary. Every node, edge, and document carries one of these;
 * every query carries the requester's clearance, and results above
 * that level are filtered out before they are ever assembled into a
 * response - not redacted after the fact.
 */
export enum ClearanceLevel {
  PUBLIC = 0,
  INTERNAL = 1,
  CONFIDENTIAL = 2,
  SECRET = 3,
  TOP_SECRET = 4,
}

export function clearanceAtLeast(level: ClearanceLevel, required: ClearanceLevel): boolean {
  return level >= required;
}

export function parseClearance(value: unknown, fallback = ClearanceLevel.PUBLIC): ClearanceLevel {
  if (typeof value === 'number' && value in ClearanceLevel) return value as ClearanceLevel;
  if (typeof value === 'string' && value.toUpperCase() in ClearanceLevel) {
    return ClearanceLevel[value.toUpperCase() as keyof typeof ClearanceLevel];
  }
  return fallback;
}
