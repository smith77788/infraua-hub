import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphStore } from '../../core/graph/GraphStore';
import { OntologyManifest } from '../../core/graph/OntologyManifest';
import { VectorIndex } from '../../core/vector/VectorIndex';
import { AuditLog } from '../../core/audit/AuditLog';
import { ClearanceLevel } from '../../core/security/Clearance';
import { StructuredRecordConnector, StructuredMapping } from '../../core/ingestion/StructuredRecordConnector';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

const manifest = new OntologyManifest({
  entity_types: {
    Person: { properties: [], default_clearance: 'PUBLIC' },
    Organization: { properties: [], default_clearance: 'PUBLIC' },
  },
  edge_types: {
    WORKS_FOR: { from: 'Person', to: 'Organization' },
  },
});

const rosterMapping: StructuredMapping = {
  entities: [
    { type: 'Person', idField: 'emp_id', labelField: 'emp_name', properties: ['role', 'risk_score', 'badge'] },
    { type: 'Organization', idField: 'org_id', labelField: 'org_name' },
  ],
  edges: [{ relation: 'WORKS_FOR', fromField: 'emp_id', toField: 'org_id' }],
};

describe('StructuredRecordConnector', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'structured-connector-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const graph = new GraphStore(path.join(dir, 'graph.json'), manifest);
    const vectors = new VectorIndex();
    const audit = new AuditLog(path.join(dir, 'audit.log'));
    const connector = new StructuredRecordConnector(graph, vectors, audit);
    return { graph, vectors, audit, connector };
  }

  it('maps a roster into deduplicated graph nodes, edges and searchable documents', () => {
    const { graph, vectors, connector } = setup();

    const result = connector.ingest(
      [
        { emp_id: '1', emp_name: 'John Doe', org_id: 'A1', org_name: 'Acme Corp', role: 'Director', risk_score: '42', badge: '007' },
        { emp_id: '2', emp_name: 'Jane Roe', org_id: 'A1', org_name: 'Acme Corp', role: 'Analyst', risk_score: '10', badge: '011' },
      ],
      rosterMapping,
      'roster.csv',
      'Corporate',
      ClearanceLevel.PUBLIC
    );

    const { nodes, edges } = graph.toJSON();
    expect(nodes).toHaveLength(3); // 2 Person + 1 deduplicated Organization
    expect(edges).toHaveLength(2);
    expect(result.rowsProcessed).toBe(2);
    expect(result.documents).toHaveLength(2);
    expect(vectors.size()).toBe(2);

    const john = nodes.find((n) => n.label === 'John Doe')!;
    expect(john.properties.risk_score).toBe(42); // coerced to a number
    expect(john.properties.badge).toBe('007'); // leading zero preserved as a string
  });

  it('rejects an undeclared relation without aborting the row', () => {
    const { connector } = setup();

    const mappingWithBadEdge: StructuredMapping = {
      ...rosterMapping,
      edges: [...rosterMapping.edges, { relation: 'ROGUE_RELATION', fromField: 'emp_id', toField: 'org_id' }],
    };

    const result = connector.ingest(
      [{ emp_id: '1', emp_name: 'John Doe', org_id: 'A1', org_name: 'Acme Corp' }],
      mappingWithBadEdge,
      'roster.csv',
      'Corporate',
      ClearanceLevel.PUBLIC
    );

    expect(result.edgesRejected).toHaveLength(1);
    expect(result.edgesRejected[0].reason).toMatch(/ontology manifest/);
    expect(result.edgesCreated.some((e) => e.includes('WORKS_FOR'))).toBe(true);
  });

  it('enforces clearance on both the graph node and the vector index', () => {
    const { graph, vectors, connector } = setup();

    const result = connector.ingest(
      [{ emp_id: '1', emp_name: 'John Doe', org_id: 'A1', org_name: 'Acme Corp' }],
      rosterMapping,
      'roster.csv',
      'Corporate',
      ClearanceLevel.SECRET
    );

    const personId = result.nodesCreated.find((id) => id.startsWith('person_'))!;
    expect(graph.getNode(personId, ClearanceLevel.PUBLIC)).toBeNull();
    expect(graph.getNode(personId, ClearanceLevel.SECRET)).not.toBeNull();
    expect(vectors.search('John Doe Acme', ClearanceLevel.PUBLIC)).toHaveLength(0);
    expect(vectors.search('John Doe Acme', ClearanceLevel.SECRET).length).toBeGreaterThan(0);
  });

  it('appends exactly one audit entry per ingest call regardless of row count', () => {
    const { audit, connector } = setup();

    connector.ingest(
      [
        { emp_id: '1', emp_name: 'John Doe', org_id: 'A1', org_name: 'Acme Corp' },
        { emp_id: '2', emp_name: 'Jane Roe', org_id: 'A1', org_name: 'Acme Corp' },
        { emp_id: '3', emp_name: 'Jim Poe', org_id: 'A1', org_name: 'Acme Corp' },
      ],
      rosterMapping,
      'roster.csv',
      'Corporate',
      ClearanceLevel.PUBLIC
    );

    const entries = audit.all();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('ingest_structured_records');
    expect((entries[0].details as { rowsProcessed: number }).rowsProcessed).toBe(3);
    expect(audit.verify().valid).toBe(true);
  });

  it('skips an entity and its edges when the id field is blank, without recording a rejection', () => {
    const { graph, connector } = setup();

    const result = connector.ingest(
      [{ emp_id: '1', emp_name: 'John Doe', org_id: '', org_name: '' }],
      rosterMapping,
      'roster.csv',
      'Corporate',
      ClearanceLevel.PUBLIC
    );

    expect(graph.findByType('Organization')).toHaveLength(0);
    expect(result.edgesCreated).toHaveLength(0);
    expect(result.edgesRejected).toHaveLength(0);
  });

  it('throws synchronously when an edge references a field that is not any entity idField', () => {
    const { connector } = setup();

    const badMapping: StructuredMapping = {
      entities: rosterMapping.entities,
      edges: [{ relation: 'WORKS_FOR', fromField: 'emp_id', toField: 'nonexistent_field' }],
    };

    expect(() =>
      connector.ingest(
        [{ emp_id: '1', emp_name: 'John Doe', org_id: 'A1', org_name: 'Acme Corp' }],
        badMapping,
        'roster.csv',
        'Corporate',
        ClearanceLevel.PUBLIC
      )
    ).toThrow(/idField/);
  });

  it('skips a fully-blank row entirely but still counts it in rowsProcessed', () => {
    const { connector } = setup();

    const result = connector.ingest(
      [
        { emp_id: '1', emp_name: 'John Doe', org_id: 'A1', org_name: 'Acme Corp' },
        { emp_id: '', emp_name: '', org_id: '', org_name: '' },
      ],
      rosterMapping,
      'roster.csv',
      'Corporate',
      ClearanceLevel.PUBLIC
    );

    expect(result.rowsProcessed).toBe(2);
    expect(result.documents).toHaveLength(1);
    expect(result.nodesCreated).toHaveLength(2);
  });
});
