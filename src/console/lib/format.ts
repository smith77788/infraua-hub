import { ClearanceLevel, CLEARANCE_NAMES, type NodeType } from "./types";

/**
 * Console-specific formatting and the class/colour mappings for the two
 * dimensions this product is built around: classification and entity type.
 * `cn` is not re-exported here — the project already has one in
 * src/lib/utils.ts and two would drift.
 */

export function clearanceName(level: ClearanceLevel): string {
  return CLEARANCE_NAMES[level] ?? `LEVEL_${level}`;
}

/** Tailwind text/border/background classes per clearance, used everywhere a level is shown. */
export function clearanceClasses(level: ClearanceLevel): string {
  switch (level) {
    case ClearanceLevel.PUBLIC:
      return "text-clearance-public border-clearance-public/40 bg-clearance-public/10";
    case ClearanceLevel.INTERNAL:
      return "text-clearance-internal border-clearance-internal/40 bg-clearance-internal/10";
    case ClearanceLevel.CONFIDENTIAL:
      return "text-clearance-confidential border-clearance-confidential/40 bg-clearance-confidential/10";
    case ClearanceLevel.SECRET:
      return "text-clearance-secret border-clearance-secret/40 bg-clearance-secret/10";
    case ClearanceLevel.TOP_SECRET:
      return "text-clearance-topsecret border-clearance-topsecret/40 bg-clearance-topsecret/10";
    default:
      return "text-muted-foreground border-border bg-muted";
  }
}

/** Raw CSS colour for a clearance — for canvas/SVG/map, which cannot use classes. */
export function clearanceColorVar(level: ClearanceLevel): string {
  const key =
    (
      {
        [ClearanceLevel.PUBLIC]: "public",
        [ClearanceLevel.INTERNAL]: "internal",
        [ClearanceLevel.CONFIDENTIAL]: "confidential",
        [ClearanceLevel.SECRET]: "secret",
        [ClearanceLevel.TOP_SECRET]: "topsecret",
      } as Record<number, string>
    )[level] ?? "public";
  return `var(--clearance-${key})`;
}

const ENTITY_VARS: Record<NodeType, string> = {
  Person: "--entity-person",
  Organization: "--entity-organization",
  Asset: "--entity-asset",
  Location: "--entity-location",
  Event: "--entity-event",
};

export function entityColorVar(type: NodeType): string {
  return `var(${ENTITY_VARS[type] ?? "--entity-person"})`;
}

export function entityClasses(type: NodeType): string {
  switch (type) {
    case "Person":
      return "text-entity-person border-entity-person/40 bg-entity-person/10";
    case "Organization":
      return "text-entity-organization border-entity-organization/40 bg-entity-organization/10";
    case "Asset":
      return "text-entity-asset border-entity-asset/40 bg-entity-asset/10";
    case "Location":
      return "text-entity-location border-entity-location/40 bg-entity-location/10";
    case "Event":
      return "text-entity-event border-entity-event/40 bg-entity-event/10";
    default:
      return "text-muted-foreground border-border bg-muted";
  }
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "Z");
}

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/** Truncates in the middle, so both ends of an id or hash stay readable. */
export function ellipsize(value: string, max = 24): string {
  if (value.length <= max) return value;
  const half = Math.floor((max - 1) / 2);
  return `${value.slice(0, half)}…${value.slice(-half)}`;
}

/** Reads a numeric property off a node/edge properties bag, or null. */
export function numericProp(properties: Record<string, unknown>, key: string): number | null {
  const raw = properties[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Number(raw.replace(/[,$\s]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
