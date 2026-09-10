import { GraphStore } from '../graph/GraphStore';
import { VectorIndex, IndexedDocument } from '../vector/VectorIndex';
import { AuditLog } from '../audit/AuditLog';
import { ClearanceLevel } from '../security/Clearance';

/**
 * Ingests Ukrainian public procurement (Prozorro) into the ontology.
 *
 * ## Why this connector exists
 *
 * The ontology has carried `AWARDED_CONTRACT` and `HIDDEN_BENEFICIARY_OF`
 * since the beginning, and `config/risk_signals.json` scores a `self_dealing`
 * combination at 35 points - the heaviest signal in the file. None of it had a
 * source. Half the risk model was scoring a kind of data that never arrived,
 * which is worse than not having it: the analytics endpoint reported bands and
 * rankings computed over relations that structurally could not exist.
 *
 * Prozorro is the source that makes that half real. It is fully open, needs no
 * key, and its records carry the one thing name-matching cannot supply: the
 * EDRPOU registration code, which is a genuine identity for a legal entity.
 *
 * ## Identity comes from the registry code, never from the name
 *
 * Nodes are keyed `org:edr:<code>`. A company appears in these records under
 * several spellings - with and without its legal form, in capitals, with the
 * form spelled out in full - and every one of them is the same registered
 * entity. Keying on the code makes those one node by construction instead of
 * making them a resolution problem afterwards.
 *
 * Organizations that arrive from other feeds (an OSM `operator` tag, say) keep
 * their own slug ids and are deliberately *not* force-merged with these: that
 * is what the duplicate resolver proposes and a human decides, per the rule
 * that this platform never merges identities on a score.
 *
 * ## What is a node and what is a property
 *
 * An award is an **edge** carrying the amount, not an Event node. That is not
 * a modelling preference: `value_concentration` in the risk signals sums the
 * `amount` property across an entity's edges, so an award recorded any other
 * way would be invisible to the scoring this connector exists to feed.
 */

export interface ProzorroIdentifier {
  scheme?: string;
  id?: string | number;
  legalName?: string;
}

export interface ProzorroParty {
  name?: string;
  identifier?: ProzorroIdentifier;
  address?: { region?: string; locality?: string; countryName?: string };
  scale?: string;
}

export interface ProzorroValue {
  amount?: number;
  currency?: string;
}

export interface ProzorroAward {
  id?: string;
  status?: string;
  date?: string;
  value?: ProzorroValue;
  suppliers?: ProzorroParty[];
}

export interface ProzorroTender {
  id?: string;
  tenderID?: string;
  title?: string;
  status?: string;
  procurementMethod?: string;
  procurementMethodType?: string;
  dateModified?: string;
  value?: ProzorroValue;
  procuringEntity?: ProzorroParty;
  awards?: ProzorroAward[] | null;
}

export interface ProzorroIngestResult {
  tendersRead: number;
  tendersIngested: number;
  organizationsIngested: number;
  awardsIngested: number;
  /** Tenders skipped, with the reason - never silently dropped. */
  skipped: { tenderID: string; reason: string }[];
  rejected: { edge: string; reason: string }[];
  documents: IndexedDocument[];
}

/**
 * Procurement methods that award without competition.
 *
 * A contract award is not by itself interesting - the state buys things. A
 * *non-competitive* award of significant value to a counterparty the buyer has
 * a relationship with is the thing worth looking at, so the distinction has to
 * survive ingestion as a property rather than being flattened away.
 *
 * Names taken from the values Prozorro actually returns in
 * `procurementMethodType`, not from the procurement law's own vocabulary.
 */
const NON_COMPETITIVE_METHODS = new Set([
  'negotiation',
  'negotiation.quick',
  'reporting',
  'priceQuotation',
]);

function organizationId(party: ProzorroParty): string | null {
  const code = party.identifier?.id;
  if (code === undefined || code === null) return null;
  const cleaned = String(code).trim();
  // EDRPOU is 8 digits; individual entrepreneurs carry a 10-digit tax number.
  // Anything else is a foreign or malformed identifier and must not be keyed
  // as if it were a Ukrainian registry code.
  if (!/^\d{8,10}$/.test(cleaned)) return null;
  return `org:edr:${cleaned}`;
}

function nameOf(party: ProzorroParty): string {
  return (party.identifier?.legalName || party.name || '').trim();
}

export class ProzorroConnector {
  constructor(
    private readonly graph: GraphStore,
    private readonly vectors: VectorIndex,
    private readonly audit: AuditLog,
  ) {}

  ingest(
    tenders: ProzorroTender[],
    source: string,
    clearance: ClearanceLevel = ClearanceLevel.PUBLIC,
    compartments: readonly string[] = [],
  ): ProzorroIngestResult {
    if (!Array.isArray(tenders)) throw new Error('tenders must be an array');

    const result: ProzorroIngestResult = {
      tendersRead: tenders.length,
      tendersIngested: 0,
      organizationsIngested: 0,
      awardsIngested: 0,
      skipped: [],
      rejected: [],
      documents: [],
    };

    const seenOrganizations = new Set<string>();

    // One persist for the whole batch: a page of a hundred tenders would
    // otherwise rewrite the growing graph several hundred times.
    this.graph.runBatch(() => {
      tenders.forEach((tender, index) => {
        const tenderKey = tender.tenderID || tender.id || `row-${index}`;

        const buyer = tender.procuringEntity;
        if (!buyer) {
          result.skipped.push({ tenderID: tenderKey, reason: 'no procuringEntity' });
          return;
        }
        const buyerId = organizationId(buyer);
        if (!buyerId) {
          // Without a registry code there is no identity, only a name - and a
          // name-keyed node here would collide with a genuinely different
          // company sharing it. Skipped loudly rather than guessed.
          result.skipped.push({ tenderID: tenderKey, reason: 'procuringEntity has no usable EDRPOU' });
          return;
        }

        const documentId = `${source}#${tenderKey}`;

        const upsertOrganization = (party: ProzorroParty, id: string) => {
          this.graph.upsertNode({
            id,
            type: 'Organization',
            label: nameOf(party) || id,
            properties: {
              edrpou: id.slice('org:edr:'.length),
              legal_name: nameOf(party),
              ...(party.address?.region ? { region: party.address.region } : {}),
              ...(party.address?.locality ? { locality: party.address.locality } : {}),
              ...(party.address?.countryName ? { country: party.address.countryName } : {}),
              ...(party.scale ? { scale: party.scale } : {}),
            },
            clearance,
            compartments,
            sourceDocId: documentId,
          });
          if (!seenOrganizations.has(id)) {
            seenOrganizations.add(id);
            result.organizationsIngested += 1;
          }
        };

        upsertOrganization(buyer, buyerId);

        const method = tender.procurementMethodType ?? tender.procurementMethod ?? '';
        const competitive = !NON_COMPETITIVE_METHODS.has(method);

        let awardsHere = 0;
        for (const award of tender.awards ?? []) {
          // Only an active award is a contract. Cancelled and unsuccessful
          // ones are part of the story but not of the money, and counting them
          // in `value_concentration` would inflate every buyer that ever ran a
          // failed procedure.
          if (award.status !== 'active') continue;

          for (const supplier of award.suppliers ?? []) {
            const supplierId = organizationId(supplier);
            if (!supplierId) {
              result.skipped.push({ tenderID: tenderKey, reason: 'supplier has no usable EDRPOU' });
              continue;
            }
            upsertOrganization(supplier, supplierId);

            if (supplierId === buyerId) {
              // A buyer awarding to itself is either a data error or the
              // finding of the year. Either way it is not an edge from a node
              // to itself, which the graph cannot traverse anyway.
              result.skipped.push({ tenderID: tenderKey, reason: 'buyer and supplier are the same entity' });
              continue;
            }

            const amount = award.value?.amount ?? tender.value?.amount;
            try {
              this.graph.upsertEdge({
                source: buyerId,
                target: supplierId,
                relation: 'AWARDED_CONTRACT',
                properties: {
                  tender_id: tenderKey,
                  title: tender.title ?? '',
                  ...(typeof amount === 'number' ? { amount } : {}),
                  currency: award.value?.currency ?? tender.value?.currency ?? 'UAH',
                  method,
                  competitive,
                  ...(award.date ? { awarded_at: award.date } : {}),
                },
                // The contract exists from the day it was awarded, not from
                // the day this connector happened to read the register.
                ...(award.date ? { validFrom: award.date } : {}),
                clearance,
                compartments,
                sourceDocId: documentId,
              });
              awardsHere += 1;
              result.awardsIngested += 1;
            } catch (err) {
              result.rejected.push({
                edge: `${buyerId}-[AWARDED_CONTRACT]->${supplierId}`,
                reason: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }

        const doc: IndexedDocument = {
          id: documentId,
          text: this.describe(tender, buyer, awardsHere),
          source,
          sector: 'procurement',
          clearance,
          ...(compartments.length ? { compartments: [...compartments] } : {}),
        };
        this.vectors.addDocument(doc);
        result.documents.push(doc);
        result.tendersIngested += 1;
      });
    });

    this.audit.append('prozorro-connector', 'ingest_prozorro', {
      source,
      clearance,
      compartments,
      tendersRead: result.tendersRead,
      tendersIngested: result.tendersIngested,
      organizationsIngested: result.organizationsIngested,
      awardsIngested: result.awardsIngested,
      skipped: result.skipped.length,
      rejected: result.rejected.length,
    });

    return result;
  }

  /** The searchable text for a tender: what an analyst would type looking for it. */
  private describe(tender: ProzorroTender, buyer: ProzorroParty, awards: number): string {
    const parts = [
      tender.tenderID ?? '',
      tender.title ?? '',
      nameOf(buyer),
      buyer.address?.region ?? '',
      buyer.address?.locality ?? '',
      tender.procurementMethodType ?? '',
      tender.status ?? '',
      typeof tender.value?.amount === 'number' ? `${tender.value.amount} ${tender.value.currency ?? ''}` : '',
      awards > 0 ? `присуджено ${awards}` : '',
    ];
    return parts.filter(Boolean).join(' — ');
  }
}
