import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphStore } from '../../core/graph/GraphStore';
import { VectorIndex } from '../../core/vector/VectorIndex';
import { AuditLog } from '../../core/audit/AuditLog';
import { IngestionService } from '../../core/ingestion/IngestionService';
import { ClearanceLevel } from '../../core/security/Clearance';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

describe('IngestionService', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingestion-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ingests a document into the graph, the vector index, and the audit log together', () => {
    const graph = new GraphStore(path.join(dir, 'graph.json'));
    const vectors = new VectorIndex();
    const audit = new AuditLog(path.join(dir, 'audit.log'));
    const service = new IngestionService(graph, vectors, audit);

    const result = service.ingest(
      'Compliance audit: Director John Doe approved a no-bid contract worth $1,500,000 with Shell Consulting LLC, a hidden beneficiary vendor.',
      'Audit_Report.txt',
      'Corporate',
      ClearanceLevel.CONFIDENTIAL
    );

    expect(result.nodesCreated.length).toBeGreaterThan(0);
    expect(result.edgesCreated.length).toBeGreaterThan(0);
    expect(vectors.size()).toBe(1);

    const johnNode = graph.findByLabelContains('John Doe', ClearanceLevel.CONFIDENTIAL)[0];
    expect(johnNode).toBeDefined();
    expect(johnNode.clearance).toBe(ClearanceLevel.CONFIDENTIAL);
    expect(johnNode.source_doc_ids).toContain(result.documentId);

    const auditEntries = audit.all();
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0].action).toBe('ingest_document');
    expect(audit.verify().valid).toBe(true);
  });

  it('respects clearance: a document ingested as SECRET is invisible to a PUBLIC reader', () => {
    const graph = new GraphStore();
    const vectors = new VectorIndex();
    const audit = new AuditLog(path.join(dir, 'audit.log'));
    const service = new IngestionService(graph, vectors, audit);

    service.ingest('Director Jane Roe controls Offshore Holdings LLC.', 'Secret_Memo.txt', 'Corporate', ClearanceLevel.SECRET);

    expect(graph.findByLabelContains('Jane Roe', ClearanceLevel.PUBLIC)).toHaveLength(0);
    expect(graph.findByLabelContains('Jane Roe', ClearanceLevel.SECRET)).toHaveLength(1);
    expect(vectors.search('Jane Roe Offshore', ClearanceLevel.PUBLIC)).toHaveLength(0);
    expect(vectors.search('Jane Roe Offshore', ClearanceLevel.SECRET).length).toBeGreaterThan(0);
  });
});
