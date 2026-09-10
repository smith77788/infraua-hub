import { NodeType } from '../graph/types';

export interface ExtractedNode {
  type: NodeType;
  label: string;
  properties: Record<string, unknown>;
}

export interface ExtractedEdge {
  sourceLabel: string;
  targetLabel: string;
  relation: string;
  properties: Record<string, unknown>;
}

export interface ExtractionResult {
  nodes: ExtractedNode[];
  edges: ExtractedEdge[];
}

const ORG_PATTERN = /\b((?:ООО|ОАО|ЗАО|АО|ИП)\s*«?[A-ZА-ЯЁ][\wа-яёА-ЯЁ\- ]{1,40}»?|[A-Z][\w-]+(?:\s+[A-Z][\w-]+)*\s+(?:Inc\.?|LLC|Ltd\.?|Corp\.?|Corporation|Co\.?))/g;
const PERSON_RUN_PATTERN = /\b(?:[A-ZА-ЯЁ][\wа-яёё-]*\s+){1,3}[A-ZА-ЯЁ][\wа-яёё-]*\b/g;
// Titles/role words that commonly precede a name ("Director John Doe") -
// stripped off the front of a capitalized run so the remainder is just
// the name, instead of naively taking the first two capitalized words.
const ROLE_WORDS = new Set([
  'director', 'mr', 'mrs', 'ms', 'president', 'ceo', 'cfo', 'cpo', 'coo', 'manager', 'head', 'chief', 'owner',
  'audit', 'compliance', 'logistics', 'alert', 'report', 'summary',
  'директор', 'комбриг', 'начальник', 'руководитель', 'менеджер', 'аудит', 'отчет', 'сводка',
]);
const MONEY_PATTERN = /(?:[$€₽]\s?[\d][\d,.\s]*|\d[\d,.\s]*\s?(?:USD|EUR|руб\.?|₽|млн|тыс\.?))/gi;
const DELAY_PATTERN = /(\d+)\s?(?:дн(?:я|ей)?|days?)/i;
const COORD_PATTERN = /(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/;

const RELATION_CUES: { pattern: RegExp; relation: string; edgeType: 'Person->Organization' | 'Organization->Asset' }[] = [
  { pattern: /бенефициар|скрытый владелец|hidden beneficiary/i, relation: 'HIDDEN_BENEFICIARY_OF', edgeType: 'Person->Organization' },
  { pattern: /без тендера|без конкурса|no-bid|awarded contract|тендер/i, relation: 'AWARDED_CONTRACT', edgeType: 'Person->Organization' },
  { pattern: /director|директор|комбриг|начальник|руководител|employee of|member of|ceo|cfo|cpo|coo/i, relation: 'AFFILIATED_WITH', edgeType: 'Person->Organization' },
];

const SUPPLY_CUES = /критическ(?:ий|ая)|задержк|сбой поставки|delay|disruption/i;

function extractPersons(sentence: string, orgs: string[]): string[] {
  const runs = Array.from(sentence.matchAll(PERSON_RUN_PATTERN)).map((m) => m[0].trim());
  const persons: string[] = [];
  for (const run of runs) {
    const words = run.split(/\s+/);
    while (words.length > 2 && ROLE_WORDS.has(words[0].toLowerCase())) words.shift();
    if (words.length >= 2 && ROLE_WORDS.has(words[0].toLowerCase())) words.shift();
    if (words.length < 2) continue;
    const candidate = words.slice(-2).join(' ');
    if (!orgs.some((o) => o.includes(candidate))) persons.push(candidate);
  }
  return Array.from(new Set(persons));
}

function stripMoney(match: string): number {
  const digits = match.replace(/[^\d.]/g, '');
  const value = parseFloat(digits);
  if (/млн/i.test(match)) return value * 1_000_000;
  if (/тыс/i.test(match)) return value * 1_000;
  return value;
}

/**
 * Deterministic, rule-based fact extraction from unstructured text -
 * money amounts, delay durations, coordinates, organization/person
 * mentions, and a small set of relation cues (beneficiary, contract
 * award, affiliation, supply disruption). This is an explicit MVP
 * placeholder for real NER/relation-extraction (spaCy, a fine-tuned
 * LLM extractor, etc.): it is not fake in the sense of "hardcoded to
 * the demo text" - every regex genuinely fires on new input with the
 * same surface structure - but its recall on free-form prose is
 * limited by design. See docs/analyst-architecture.md "Ingestion".
 */
export class EntityExtractor {
  extract(text: string): ExtractionResult {
    const nodes: ExtractedNode[] = [];
    const edges: ExtractedEdge[] = [];
    const sentences = text.split(/(?<=[.!?\n])\s+/).filter((s) => s.trim().length > 0);

    for (const sentence of sentences) {
      const orgs = Array.from(new Set(Array.from(sentence.matchAll(ORG_PATTERN)).map((m) => m[0].trim())));
      const persons = extractPersons(sentence, orgs);
      const moneyMatches = Array.from(sentence.matchAll(MONEY_PATTERN)).map((m) => m[0]);
      const delayMatch = sentence.match(DELAY_PATTERN);
      const coordMatch = sentence.match(COORD_PATTERN);

      for (const org of orgs) nodes.push({ type: 'Organization', label: org, properties: {} });
      for (const person of persons) nodes.push({ type: 'Person', label: person, properties: {} });

      if (coordMatch) {
        const label = `Location (${coordMatch[1]}, ${coordMatch[2]})`;
        nodes.push({
          type: 'Location',
          label,
          properties: { lat: parseFloat(coordMatch[1]), lon: parseFloat(coordMatch[2]) },
        });
        // Anchor the coordinate to whichever named entity the sentence is
        // actually about, so a distance/logistics query can reach it by
        // name instead of only by scanning every Location in the graph.
        const anchorLabel = orgs[0] ?? persons[0];
        if (anchorLabel) {
          edges.push({ sourceLabel: anchorLabel, targetLabel: label, relation: 'LOCATED_AT', properties: {} });
        }
      }

      if (persons.length > 0 && orgs.length > 0) {
        // Only the first matching cue per sentence: a sentence describing one
        // fact (e.g. a no-bid award to a hidden-beneficiary vendor) should
        // produce one relation, not one per cue that happens to match the
        // same clause - otherwise an aggregation would double-count its amount.
        const cue = RELATION_CUES.find((c) => c.pattern.test(sentence));
        if (cue) {
          const properties: Record<string, unknown> = {};
          if (moneyMatches.length > 0) properties.amount = stripMoney(moneyMatches[0]);
          edges.push({ sourceLabel: persons[0], targetLabel: orgs[0], relation: cue.relation, properties });
        }
      }

      if (orgs.length >= 2 && SUPPLY_CUES.test(sentence)) {
        const properties: Record<string, unknown> = {};
        if (delayMatch) properties.delay_days = parseInt(delayMatch[1], 10);
        edges.push({ sourceLabel: orgs[0], targetLabel: orgs[1], relation: 'SUPPLY_DISRUPTION', properties });
      }
    }

    return { nodes, edges };
  }
}
