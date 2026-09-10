import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphStore } from '../../core/graph/GraphStore';
import { VectorIndex } from '../../core/vector/VectorIndex';
import { AuditLog } from '../../core/audit/AuditLog';
import { IngestionService } from '../../core/ingestion/IngestionService';
import { InvestigatorAgent } from '../../agents/analyst/InvestigatorAgent';
import { ClearanceLevel } from '../../core/security/Clearance';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

/**
 * Anchor resolution decides which entities an investigation traverses from.
 * Get it wrong in one direction and the subgraph fills with entities the
 * query never mentioned; get it wrong in the other and the investigation
 * returns nothing at all. Both failures produce an answer that looks
 * confident, so they are worth pinning explicitly.
 */
describe('investigation anchor resolution', () => {
  let dir: string;
  let graph: GraphStore;
  let vectors: VectorIndex;
  let audit: AuditLog;
  let ingestion: IngestionService;
  let investigator: InvestigatorAgent;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchors-'));
    graph = new GraphStore(path.join(dir, 'graph.json'));
    vectors = new VectorIndex();
    audit = new AuditLog(path.join(dir, 'audit.log'));
    ingestion = new IngestionService(graph, vectors, audit);
    investigator = new InvestigatorAgent(graph, vectors, audit, path.join(dir, 'sandbox'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const labelsIn = (nodes: { label: string }[]) => nodes.map((n) => n.label);

  it('does not anchor every "Corp" on the word "corporate"', async () => {
    // The old matcher tested `query.includes(labelWord)` on tokens longer than
    // three characters, so "corporate" contained "corp" and dragged in every
    // organization in the graph as a traversal root.
    ingestion.ingest(
      'Director John Doe approved a contract worth $500,000 with Acme Corp.',
      'A.txt',
      'Corporate',
      ClearanceLevel.PUBLIC,
    );
    ingestion.ingest(
      'Director Jane Roe approved a contract worth $700,000 with Globex Corp.',
      'B.txt',
      'Corporate',
      ClearanceLevel.PUBLIC,
    );

    const result = await investigator.investigate(
      'general corporate governance review',
      ClearanceLevel.PUBLIC,
    );

    expect(labelsIn(result.subgraph.nodes)).not.toContain('Acme Corp.');
    expect(labelsIn(result.subgraph.nodes)).not.toContain('Globex Corp.');
  }, 30000);

  it('still anchors on the distinctive part of a name', async () => {
    ingestion.ingest(
      'Director John Doe approved a contract worth $500,000 with Acme Corp.',
      'A.txt',
      'Corporate',
      ClearanceLevel.PUBLIC,
    );
    ingestion.ingest(
      'Director Jane Roe approved a contract worth $700,000 with Globex Corp.',
      'B.txt',
      'Corporate',
      ClearanceLevel.PUBLIC,
    );

    const result = await investigator.investigate(
      'what contracts involve Acme?',
      ClearanceLevel.PUBLIC,
    );

    const labels = labelsIn(result.subgraph.nodes);
    expect(labels).toContain('Acme Corp.');
    // Globex has nothing to do with the question and must not be traversed.
    expect(labels).not.toContain('Globex Corp.');
  }, 30000);

  it('anchors a short acronym label the old length filter excluded', async () => {
    // Written against the graph rather than through ingestion on purpose: the
    // rule-based EntityExtractor does not lift a bare acronym out of prose, so
    // ingesting the sentence would test extraction instead of the matching
    // this case is about. Short labels reach the graph through the structured
    // connector every day.
    graph.upsertNode({ id: 'organization-ibm', type: 'Organization', label: 'IBM' });
    graph.upsertNode({ id: 'person-john-doe', type: 'Person', label: 'John Doe' });
    graph.upsertEdge({
      source: 'person-john-doe',
      target: 'organization-ibm',
      relation: 'AWARDED_CONTRACT',
      properties: { amount: 500_000 },
    });

    const result = await investigator.investigate(
      'what contracts involve IBM?',
      ClearanceLevel.PUBLIC,
    );

    expect(labelsIn(result.subgraph.nodes)).toContain('IBM');
  }, 30000);

  it('narrows to the named party when several share a generic word', async () => {
    ingestion.ingest(
      'Director John Doe approved a contract worth $100,000 with Northern Vendor Corp.',
      'A.txt',
      'Corporate',
      ClearanceLevel.PUBLIC,
    );
    ingestion.ingest(
      'Director Jane Roe approved a contract worth $200,000 with Southern Vendor Corp.',
      'B.txt',
      'Corporate',
      ClearanceLevel.PUBLIC,
    );

    const result = await investigator.investigate(
      'total contract amount for Northern Vendor',
      ClearanceLevel.PUBLIC,
    );

    const labels = labelsIn(result.subgraph.nodes);
    expect(labels).toContain('Northern Vendor Corp.');
    expect(labels).not.toContain('Southern Vendor Corp.');
    // And the sum reflects only the anchored party, not both contracts.
    expect(result.computation).not.toBeNull();
    expect((result.computation!.result as { sum: number }).sum).toBe(100_000);
  }, 30000);

  it('anchors nothing when the query names nothing in the graph', async () => {
    ingestion.ingest(
      'Director John Doe approved a contract worth $500,000 with Acme Corp.',
      'A.txt',
      'Corporate',
      ClearanceLevel.PUBLIC,
    );

    const result = await investigator.investigate(
      'weather forecast for tomorrow',
      ClearanceLevel.PUBLIC,
    );

    expect(result.subgraph.nodes).toHaveLength(0);
  }, 30000);

  it('resolves anchors only among entities the caller can see', async () => {
    ingestion.ingest(
      'Director Katherine Johnson approved a contract worth $900,000 with Orbital Dynamics Inc.',
      'S.txt',
      'Defense',
      ClearanceLevel.SECRET,
    );

    const asPublic = await investigator.investigate(
      'what contracts involve Katherine Johnson?',
      ClearanceLevel.PUBLIC,
    );
    const asSecret = await investigator.investigate(
      'what contracts involve Katherine Johnson?',
      ClearanceLevel.SECRET,
    );

    expect(asPublic.subgraph.nodes).toHaveLength(0);
    expect(labelsIn(asSecret.subgraph.nodes)).toContain('Katherine Johnson');
  }, 30000);
});
