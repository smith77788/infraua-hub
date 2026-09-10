import { GraphStore } from '../graph/GraphStore';
import { VectorIndex, IndexedDocument } from '../vector/VectorIndex';
import { AuditLog } from '../audit/AuditLog';
import { ClearanceLevel } from '../security/Clearance';
import { slugify } from './IngestionService';

/**
 * Ingests the Ukrainian company register (ЄДР): who founded a company, who
 * controls it, and who its declared ultimate beneficial owner is.
 *
 * Prozorro gave the platform contracts. This gives it the people behind the
 * counterparties, which is the half that turns "this company won a lot of
 * work" into a question worth asking.
 *
 * ## Declared is not hidden
 *
 * The ontology carries `HIDDEN_BENEFICIARY_OF` and the risk config scores it
 * at 30 points. Wiring the register's `BENEFICIARIES` field to that relation
 * would have been the obvious move and would have been wrong: the register
 * holds ownership that companies **disclosed because the law requires it**,
 * and scoring disclosure as concealment would penalise every law-abiding
 * company in the country while telling an analyst the opposite of the truth.
 *
 * So declared ownership gets its own relation, `BENEFICIARY_OF`, and
 * `HIDDEN_BENEFICIARY_OF` stays reserved for ownership somebody *found* rather
 * than ownership somebody filed.
 *
 * What is a signal here is the *shape* of a disclosure: a commercial company
 * filing a boilerplate reason for having no beneficiary at all, or one whose
 * founder sits in a jurisdiction chosen for opacity. Those are recorded as
 * properties, and `config/risk_signals.json` decides what they are worth.
 *
 * ## A name is not an identity
 *
 * The register gives no tax number for a beneficiary - only a name, and
 * sometimes a citizenship. Two people called Іванов Іван Іванович are two
 * people, and a graph that keys them to one node has invented a relationship
 * between two real human beings who have none. That is the single worst
 * failure available in this domain.
 *
 * So a person is keyed **per company**: `person:edr:<edrpou>:<name-slug>`. The
 * same name in two companies is two nodes, and the duplicate resolver proposes
 * them as a candidate pair, which a human confirms with the `link_same_as`
 * action - recorded, reversible, and attributable. Nothing is merged on a
 * score, and the link that matters most is the one that needed a decision.
 *
 * ## Personal data is not open data
 *
 * The register is public, but a graph of named individuals with their holdings
 * is a different object from a map of substations, and it should not be
 * readable by every key that can read the map. So people and their relations
 * default to INTERNAL and to a `personal-data` compartment. A deployment can
 * override it; the default is the careful one.
 */

export interface EdrIngestResult {
  subjectsRead: number;
  organizationsIngested: number;
  peopleIngested: number;
  foundersLinked: number;
  beneficiariesLinked: number;
  officersLinked: number;
  /** Beneficiary entries that state an absence rather than name a person. */
  absenceDeclarations: number;
  skipped: { record: string; reason: string }[];
  rejected: { edge: string; reason: string }[];
  documents: IndexedDocument[];
}

export interface EdrSubject {
  record?: string;
  name?: string;
  shortName?: string;
  edrpou?: string;
  state?: string;
  founders: string[];
  beneficiaries: string[];
  signers: string[];
  registration?: string;
  address?: string;
}

/** Compartment personal data lands in unless a deployment says otherwise. */
export const PERSONAL_DATA_COMPARTMENT = 'personal-data';

/**
 * Jurisdictions whose defining feature, for this purpose, is that ownership
 * filed there is not publicly traceable further.
 *
 * This is not a judgement about the countries: it is the standard list used in
 * procurement-integrity work, and the property it records is "the chain of
 * ownership stops being followable here", which is a fact about registers and
 * not about people. It is recorded as a property; what it is worth is decided
 * in `config/risk_signals.json`, where an operator can disagree with it.
 */
const OPAQUE_JURISDICTIONS = new Set([
  'кіпр',
  'беліз',
  'сейшели',
  'британські віргінські острови',
  'віргінські острови',
  'панама',
  'маршаллові острови',
  'сент-кітс і невіс',
  'сент-вінсент і гренадіни',
  'домініка',
  'вануату',
  'самоа',
  'ліхтенштейн',
  'гібралтар',
  'кайманові острови',
]);

const ABSENCE_PREFIX = /^\s*причин[аи]\s+відсутност/i;

/**
 * Bytes 0x80-0xFF of windows-1251. Below 0x80 the encoding is ASCII.
 *
 * Generated from a reference codec rather than typed out, because a single
 * wrong character here corrupts one Ukrainian letter everywhere and nothing
 * reports an error - the table is checked against the published register in
 * the tests.
 */
const WINDOWS_1251_HIGH =
  'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—\ufffd™љ›њќћџ\u00a0ЎўЈ¤Ґ¦§Ё©Є«¬\u00ad®Ї°±Ііґµ¶·ё№є»јЅѕї' +
  'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя';

/**
 * Decodes windows-1251, which the register is published in and which neither
 * Node nor Bun can decode.
 *
 * `TextDecoder` supports it in browsers and throws
 * `ERR_ENCODING_NOT_SUPPORTED` on the server, so the obvious call fails loudly
 * - which is the good case. The bad case is the workaround somebody reaches
 * for next: reading the bytes as UTF-8 or latin1 raises no error at all and
 * turns every Ukrainian name in the file into mojibake, and the corruption
 * arrives in the graph looking exactly like bad source data.
 *
 * So the decoder lives here, next to the only thing that needs it, rather than
 * being a step every caller has to remember.
 */
export function decodeWindows1251(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    out += byte < 0x80 ? String.fromCharCode(byte) : WINDOWS_1251_HIGH[byte - 0x80];
  }
  return out;
}

/**
 * Reads the register from raw bytes, decoding the declared encoding.
 *
 * The XML prolog states the encoding, so it is honoured rather than assumed:
 * the register has been published as windows-1251 for years, but a file that
 * one day says UTF-8 should be read as UTF-8 rather than mangled by a decoder
 * that knows better.
 */
export function parseEdrBytes(bytes: Uint8Array): EdrSubject[] {
  const prolog = String.fromCharCode(...bytes.subarray(0, 120));
  const declared = /encoding=["']([^"']+)["']/i.exec(prolog)?.[1]?.toLowerCase() ?? '';
  if (declared.includes('1251')) return parseEdrXml(decodeWindows1251(bytes));
  // Anything else is handed to the platform decoder. An unknown label throws
  // there, which is the right outcome: a file in an encoding nobody can read
  // must fail rather than be guessed at, because guessing produces mojibake
  // that raises no error and reaches the graph looking like bad source data.
  // The label comes from the file's own prolog, so it is an arbitrary string
  // rather than one of the encodings the Node typings enumerate. An
  // unsupported label throws at runtime, which is the outcome we want.
  const decoder = new TextDecoder((declared || 'utf-8') as ConstructorParameters<typeof TextDecoder>[0]);
  return parseEdrXml(decoder.decode(bytes));
}

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function tagOf(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? decodeEntities(match[1].trim()) : '';
}

function allTags(xml: string, tag: string): string[] {
  const out: string[] = [];
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const value = decodeEntities(match[1].trim());
    if (value) out.push(value);
  }
  return out;
}

/**
 * Splits the register's XML into subjects.
 *
 * The published file is **windows-1251**, not UTF-8, and read as UTF-8 every
 * Ukrainian name in it turns to mojibake without any error being raised - the
 * kind of failure that reaches production looking like bad source data. The
 * caller decodes; this function takes text that is already correct, and the
 * API layer is where the encoding is handled, since that is where the bytes
 * arrive.
 */
export function parseEdrXml(xml: string): EdrSubject[] {
  const subjects: EdrSubject[] = [];
  const pattern = /<SUBJECT>([\s\S]*?)<\/SUBJECT>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const block = match[1];
    subjects.push({
      record: tagOf(block, 'RECORD'),
      name: tagOf(block, 'NAME'),
      shortName: tagOf(block, 'SHORT_NAME'),
      edrpou: tagOf(block, 'EDRPOU'),
      state: tagOf(block, 'STAN'),
      founders: allTags(block, 'FOUNDER'),
      beneficiaries: allTags(block, 'BENEFICIARY'),
      signers: allTags(block, 'SIGNER'),
      registration: tagOf(block, 'REGISTRATION'),
      address: tagOf(block, 'ADDRESS'),
    });
  }
  return subjects;
}

export interface ParsedFounder {
  name: string;
  /** Registry code as filed: an 8-digit EDRPOU, a foreign code, or nothing. */
  code?: string;
  country?: string;
  /** True when the code looks like a Ukrainian registry code. */
  ukrainian: boolean;
  raw: string;
}

/**
 * Parses one founder line: `NAME; CODE; резиденство: COUNTRY`.
 *
 * Fields are positional only by convention and any of them can be missing, so
 * each is recognised by shape rather than by position. The raw string is kept
 * whatever happens: a parse that drops what it did not understand leaves an
 * analyst unable to see that anything was dropped.
 */
export function parseFounder(raw: string): ParsedFounder {
  const parts = raw.split(';').map((p) => p.trim()).filter(Boolean);
  const name = parts[0] ?? '';
  let code: string | undefined;
  let country: string | undefined;

  for (const part of parts.slice(1)) {
    const residency = /^(?:резиденство|резидентство|громадянство)\s*:\s*(.+)$/i.exec(part);
    if (residency) {
      country = residency[1].trim();
      continue;
    }
    if (!code && /^[A-Za-z0-9][A-Za-z0-9./-]{3,30}$/.test(part)) code = part;
  }

  return { name, code, country, ukrainian: Boolean(code && /^\d{8}$/.test(code)), raw };
}

export interface ParsedBeneficiary {
  /** Null when the entry declares an absence rather than naming somebody. */
  name: string | null;
  citizenship?: string;
  /** Declared share, when the entry states one. */
  sharePercent?: number;
  influence?: string;
  absenceReason?: string;
  raw: string;
}

/**
 * Parses one beneficiary line.
 *
 * Two entirely different things arrive in this field, and telling them apart
 * is the whole job: a named owner, or a sentence explaining why there is none.
 * Treating the second as a person would put "Причина відсутності кінцевого
 * бенефіціарного власника" into the graph as a human being - and in the real
 * sample that is 60% of the entries.
 */
export function parseBeneficiary(raw: string): ParsedBeneficiary {
  if (ABSENCE_PREFIX.test(raw)) {
    const reason = raw.replace(/^\s*причин[аи]\s+відсутност[іи]\s*:?\s*/i, '').trim();
    return { name: null, absenceReason: reason || raw, raw };
  }

  const parts = raw.split(';').map((p) => p.trim()).filter(Boolean);
  const name = (parts[0] ?? '').replace(/\s+/g, ' ').trim();
  let citizenship: string | undefined;
  let sharePercent: number | undefined;
  let influence: string | undefined;

  for (const part of parts.slice(1)) {
    const citizen = /^громадянство\s*:\s*(.+)$/i.exec(part);
    if (citizen) {
      citizenship = citizen[1].trim();
      continue;
    }
    const share = /відсоток\s+частки\s*[-–—:]?\s*([\d.,]+)/i.exec(part);
    if (share) {
      const value = Number(share[1].replace(',', '.'));
      if (Number.isFinite(value)) sharePercent = value;
      continue;
    }
    if (/вплив/i.test(part) && !influence) influence = part;
  }

  return { name: name || null, citizenship, sharePercent, influence, raw };
}

/** Parses `Прізвище Ім'я По-батькові - роль` or `Name; (підстава) - роль`. */
export function parseSigner(raw: string): { name: string; role?: string } {
  const dash = raw.lastIndexOf(' - ');
  const role = dash >= 0 ? raw.slice(dash + 3).trim() : undefined;
  const head = dash >= 0 ? raw.slice(0, dash) : raw;
  const name = head.split(';')[0].replace(/\s+/g, ' ').trim();
  return { name, role };
}

/** `21.10.2025; 21.10.2025; 4000702000000000002` → the first date, as ISO. */
export function parseRegistrationDate(raw: string): string | undefined {
  const match = /(\d{2})\.(\d{2})\.(\d{4})/.exec(raw);
  if (!match) return undefined;
  return `${match[3]}-${match[2]}-${match[1]}T00:00:00.000Z`;
}

export class EdrConnector {
  constructor(
    private readonly graph: GraphStore,
    private readonly vectors: VectorIndex,
    private readonly audit: AuditLog,
  ) {}

  ingest(
    subjects: EdrSubject[],
    source: string,
    options: {
      /** Classification for the organizations themselves. The register is public. */
      orgClearance?: ClearanceLevel;
      /** Classification for named individuals. Deliberately higher by default. */
      personClearance?: ClearanceLevel;
      orgCompartments?: readonly string[];
      /** Compartments for personal data. Defaults to `personal-data`. */
      personCompartments?: readonly string[];
    } = {},
  ): EdrIngestResult {
    if (!Array.isArray(subjects)) throw new Error('subjects must be an array');

    const orgClearance = options.orgClearance ?? ClearanceLevel.PUBLIC;
    const personClearance = options.personClearance ?? ClearanceLevel.INTERNAL;
    const orgCompartments = options.orgCompartments ?? [];
    const personCompartments = options.personCompartments ?? [PERSONAL_DATA_COMPARTMENT];

    const result: EdrIngestResult = {
      subjectsRead: subjects.length,
      organizationsIngested: 0,
      peopleIngested: 0,
      foundersLinked: 0,
      beneficiariesLinked: 0,
      officersLinked: 0,
      absenceDeclarations: 0,
      skipped: [],
      rejected: [],
      documents: [],
    };

    const seenOrganizations = new Set<string>();
    const seenPeople = new Set<string>();

    this.graph.runBatch(() => {
      for (const subject of subjects) {
        const key = subject.record || subject.edrpou || '<unnamed>';
        const edrpou = (subject.edrpou ?? '').trim();
        if (!/^\d{8,10}$/.test(edrpou)) {
          // Without a registry code there is no identity, only a name, and a
          // name-keyed company collides with every other company sharing it.
          result.skipped.push({ record: key, reason: 'no usable EDRPOU' });
          continue;
        }

        const orgId = `org:edr:${edrpou}`;
        const documentId = `${source}#${edrpou}`;
        const registeredAt = parseRegistrationDate(subject.registration ?? '');

        const beneficiaries = subject.beneficiaries.map(parseBeneficiary);
        const absences = beneficiaries.filter((b) => b.name === null);
        result.absenceDeclarations += absences.length;

        const founders = subject.founders.map(parseFounder);
        const opaqueFounder = founders.find(
          (f) => f.country && OPAQUE_JURISDICTIONS.has(f.country.trim().toLowerCase()),
        );

        this.graph.upsertNode({
          id: orgId,
          type: 'Organization',
          label: subject.name || subject.shortName || orgId,
          properties: {
            edrpou,
            legal_name: subject.name ?? '',
            ...(subject.shortName ? { short_name: subject.shortName } : {}),
            ...(subject.state ? { registry_state: subject.state } : {}),
            ...(registeredAt ? { registered_at: registeredAt } : {}),
            ...(subject.address ? { address: subject.address } : {}),
            // Not "no owner" but "the filing says there is none, for this
            // stated reason" — a different fact, and the one worth scoring.
            ...(absences.length > 0
              ? {
                  beneficiary_absence_declared: true,
                  beneficiary_absence_reason: absences[0].absenceReason ?? '',
                }
              : {}),
            declared_beneficiaries: beneficiaries.filter((b) => b.name !== null).length,
            ...(opaqueFounder
              ? {
                  founder_jurisdiction_opaque: true,
                  founder_jurisdiction: opaqueFounder.country,
                }
              : {}),
          },
          clearance: orgClearance,
          compartments: orgCompartments,
          sourceDocId: documentId,
          ...(registeredAt ? { validFrom: registeredAt } : {}),
        });
        if (!seenOrganizations.has(orgId)) {
          seenOrganizations.add(orgId);
          result.organizationsIngested += 1;
        }

        const addPerson = (name: string, extra: Record<string, unknown>): string | null => {
          const slug = slugify(name);
          if (!slug) return null;
          // Scoped to the company: the same name elsewhere is a different node
          // until a human says otherwise. See the note at the top of the file.
          const personId = `person:edr:${edrpou}:${slug}`;
          this.graph.upsertNode({
            id: personId,
            type: 'Person',
            label: name,
            properties: {
              ...extra,
              named_in_company: edrpou,
              // Stated on the record, not left to be assumed: an id built from
              // a name is not an identity claim.
              identity_basis: 'name_as_filed_in_edr',
            },
            clearance: personClearance,
            compartments: personCompartments,
            sourceDocId: documentId,
          });
          if (!seenPeople.has(personId)) {
            seenPeople.add(personId);
            result.peopleIngested += 1;
          }
          return personId;
        };

        const link = (
          from: string,
          relation: string,
          properties: Record<string, unknown>,
          personal: boolean,
        ): boolean => {
          try {
            this.graph.upsertEdge({
              source: from,
              target: orgId,
              relation,
              properties,
              clearance: personal ? personClearance : orgClearance,
              compartments: personal ? personCompartments : orgCompartments,
              sourceDocId: documentId,
              ...(registeredAt ? { validFrom: registeredAt } : {}),
            });
            return true;
          } catch (err) {
            result.rejected.push({
              edge: `${from}-[${relation}]->${orgId}`,
              reason: err instanceof Error ? err.message : String(err),
            });
            return false;
          }
        };

        for (const founder of founders) {
          if (!founder.name) continue;
          if (founder.ukrainian && founder.code) {
            const founderId = `org:edr:${founder.code}`;
            this.graph.upsertNode({
              id: founderId,
              type: 'Organization',
              label: founder.name,
              properties: { edrpou: founder.code, legal_name: founder.name },
              clearance: orgClearance,
              compartments: orgCompartments,
              sourceDocId: documentId,
            });
            if (!seenOrganizations.has(founderId)) {
              seenOrganizations.add(founderId);
              result.organizationsIngested += 1;
            }
            if (link(founderId, 'CONTROLS', { role: 'founder', source_text: founder.raw }, false)) {
              result.foundersLinked += 1;
            }
          } else if (founder.code) {
            // Foreign entity: keyed by its own registry code and country, never
            // as if the code were Ukrainian.
            const foreignId = `org:foreign:${slugify(founder.country ?? 'unknown')}:${slugify(founder.code)}`;
            this.graph.upsertNode({
              id: foreignId,
              type: 'Organization',
              label: founder.name,
              properties: {
                legal_name: founder.name,
                registration: founder.code,
                ...(founder.country ? { country: founder.country } : {}),
                foreign: true,
              },
              clearance: orgClearance,
              compartments: orgCompartments,
              sourceDocId: documentId,
            });
            if (!seenOrganizations.has(foreignId)) {
              seenOrganizations.add(foreignId);
              result.organizationsIngested += 1;
            }
            if (link(foreignId, 'CONTROLS', { role: 'founder', source_text: founder.raw, ...(founder.country ? { country: founder.country } : {}) }, false)) {
              result.foundersLinked += 1;
            }
          } else {
            // No code at all: most often a natural person founder.
            const personId = addPerson(founder.name, { role: 'founder' });
            if (personId && link(personId, 'CONTROLS', { role: 'founder', source_text: founder.raw }, true)) {
              result.foundersLinked += 1;
            }
          }
        }

        for (const beneficiary of beneficiaries) {
          if (beneficiary.name === null) continue;
          const personId = addPerson(beneficiary.name, {
            role: 'beneficiary',
            ...(beneficiary.citizenship ? { citizenship: beneficiary.citizenship } : {}),
          });
          if (
            personId &&
            link(
              personId,
              // Declared, not discovered. See the note at the top of the file.
              'BENEFICIARY_OF',
              {
                declared: true,
                ...(beneficiary.sharePercent !== undefined ? { share_percent: beneficiary.sharePercent } : {}),
                ...(beneficiary.influence ? { influence: beneficiary.influence } : {}),
                source_text: beneficiary.raw,
              },
              true,
            )
          ) {
            result.beneficiariesLinked += 1;
          }
        }

        for (const rawSigner of subject.signers) {
          const signer = parseSigner(rawSigner);
          if (!signer.name) continue;
          const personId = addPerson(signer.name, { role: signer.role ?? 'signer' });
          if (
            personId &&
            link(personId, 'AFFILIATED_WITH', { role: signer.role ?? 'signer', source_text: rawSigner }, true)
          ) {
            result.officersLinked += 1;
          }
        }

        const doc: IndexedDocument = {
          id: documentId,
          text: [
            edrpou,
            subject.name ?? '',
            subject.shortName ?? '',
            subject.state ?? '',
            ...beneficiaries.filter((b) => b.name).map((b) => b.name as string),
            ...founders.map((f) => f.name),
          ]
            .filter(Boolean)
            .join(' — '),
          source,
          sector: 'registry',
          // The searchable text names individuals, so it carries the personal
          // marking rather than the organization's.
          clearance: personClearance,
          ...(personCompartments.length ? { compartments: [...personCompartments] } : {}),
        };
        this.vectors.addDocument(doc);
        result.documents.push(doc);
      }
    });

    this.audit.append('edr-connector', 'ingest_edr', {
      source,
      subjectsRead: result.subjectsRead,
      organizationsIngested: result.organizationsIngested,
      peopleIngested: result.peopleIngested,
      foundersLinked: result.foundersLinked,
      beneficiariesLinked: result.beneficiariesLinked,
      officersLinked: result.officersLinked,
      absenceDeclarations: result.absenceDeclarations,
      skipped: result.skipped.length,
      rejected: result.rejected.length,
      personClearance,
      personCompartments,
    });

    return result;
  }
}
