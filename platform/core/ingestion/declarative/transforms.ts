/**
 * The closed set of value transforms a source manifest may use.
 *
 * Closed, deliberately. A mapping that can run arbitrary code is a mapping
 * that can do anything, and then it is no longer a document somebody reviews -
 * it is a program somebody has to audit, running with the ingestion's own
 * rights. Every transform here is total, side-effect free and reversible in
 * the reader's head, which is what makes a manifest reviewable by an operator
 * rather than only by a programmer.
 *
 * When a feed needs something not on this list, the answer is to add a named
 * transform here - with a test - rather than to open an escape hatch.
 */

export type TransformName =
  | 'trim'
  | 'lower'
  | 'upper'
  | 'digits'
  | 'number'
  | 'slug'
  | 'iso_date'
  | 'last_path_segment'
  | 'wkt_lat'
  | 'wkt_lon'
  | 'first_word'
  | 'collapse_spaces';

export const TRANSFORM_NAMES: TransformName[] = [
  'trim',
  'lower',
  'upper',
  'digits',
  'number',
  'slug',
  'iso_date',
  'last_path_segment',
  'wkt_lat',
  'wkt_lon',
  'first_word',
  'collapse_spaces',
];

/** `POINT(30.5 50.4)` — longitude first, which is the trap in every WKT. */
function parsePoint(value: string): { lat: number; lon: number } | null {
  const match = /point\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/i.exec(value);
  if (!match) return null;
  const lon = Number(match[1]);
  const lat = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

/**
 * Parses the date formats these registers actually publish, and refuses
 * anything else.
 *
 * `new Date(x)` would accept far more and quietly agree to nonsense - it reads
 * "13.05.2026" as a valid date in one locale and as invalid in another, and
 * both outcomes reach the graph without an error.
 */
function toIsoDate(value: string): string | null {
  const trimmed = value.trim();
  const dotted = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(trimmed);
  if (dotted) return `${dotted[3]}-${dotted[2]}-${dotted[1]}T00:00:00.000Z`;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (iso) {
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }

  // A bare epoch in milliseconds, which several event feeds use.
  if (/^\d{13}$/.test(trimmed)) return new Date(Number(trimmed)).toISOString();
  return null;
}

/**
 * Applies one transform. Returns `null` when the value cannot be transformed,
 * which the caller treats as "this field is absent" rather than as an error:
 * one unparseable coordinate should cost its record, not the batch.
 */
export function applyTransform(name: TransformName, value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  const text = String(value);

  switch (name) {
    case 'trim':
      return text.trim();
    case 'lower':
      return text.toLowerCase();
    case 'upper':
      return text.toUpperCase();
    case 'collapse_spaces':
      return text.replace(/\s+/g, ' ').trim();
    case 'digits': {
      const digits = text.replace(/\D+/g, '');
      return digits.length > 0 ? digits : null;
    }
    case 'number': {
      const parsed = Number(text.replace(/\s+/g, '').replace(',', '.'));
      return Number.isFinite(parsed) ? parsed : null;
    }
    case 'slug':
      return text
        .toLowerCase()
        .normalize('NFC')
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .trim()
        .replace(/\s+/g, '_') || null;
    case 'iso_date':
      return toIsoDate(text);
    case 'last_path_segment': {
      const segment = text.split(/[/#]/).filter(Boolean).pop();
      return segment && segment.length > 0 ? segment : null;
    }
    case 'wkt_lat':
      return parsePoint(text)?.lat ?? null;
    case 'wkt_lon':
      return parsePoint(text)?.lon ?? null;
    case 'first_word': {
      const first = text.trim().split(/\s+/)[0];
      return first && first.length > 0 ? first : null;
    }
    default:
      return null;
  }
}

/** Runs a pipeline left to right, stopping at the first step that gives up. */
export function applyTransforms(names: TransformName[], value: unknown): string | number | null {
  let current: unknown = value;
  for (const name of names) {
    const next = applyTransform(name, current);
    if (next === null) return null;
    current = next;
  }
  return current === undefined || current === null ? null : (current as string | number);
}

/**
 * Reads a dotted path out of a record, walking arrays by index.
 *
 * `awards.0.suppliers.0.identifier.id` rather than a query language: paths
 * that can branch turn a mapping into a program, and a mapping has to stay
 * something an operator can read top to bottom and predict.
 */
export function readPath(record: unknown, path: string): unknown {
  let current: unknown = record;
  for (const segment of path.split('.')) {
    if (current === undefined || current === null) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
