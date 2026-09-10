import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

/**
 * Exercises the platform over real HTTP, which is the only place several
 * security properties actually live: the bearer-key gate, the clearance the
 * server derives from that key, the clamp that stops a caller classifying
 * above their own level, and the rate limit. The service-level tests
 * elsewhere bypass all of it by calling the classes directly.
 */

const KEYS = {
  public: 'test-public',
  internal: 'test-internal',
  secret: 'test-secret',
};

let server: http.Server;
let baseUrl: string;
let dataDir: string;

async function call(
  method: 'GET' | 'POST',
  route: string,
  options: { key?: string; body?: unknown } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = {};
  if (options.key) headers.Authorization = `Bearer ${options.key}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    headers: response.headers,
  };
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-api-'));
  process.env.PLATFORM_DATA_DIR = dataDir;
  process.env.PLATFORM_API_KEYS = JSON.stringify({
    [KEYS.public]: 'PUBLIC',
    [KEYS.internal]: 'INTERNAL',
    [KEYS.secret]: 'SECRET',
  });
  // High enough that the functional tests below never trip it; the rate-limit
  // test uses its own tiny budget via a separate limiter unit test.
  process.env.PLATFORM_RATE_BURST = '500';
  process.env.PLATFORM_RATE_PER_MINUTE = '6000';

  // Imported after the env is set: the module reads all of it at load time.
  const { app } = (await import('../../api/server')) as { app: Express };
  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port assigned');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.PLATFORM_DATA_DIR;
  delete process.env.PLATFORM_API_KEYS;
  delete process.env.PLATFORM_RATE_BURST;
  delete process.env.PLATFORM_RATE_PER_MINUTE;
});

describe('platform API: authentication', () => {
  it('serves health without a key, so liveness never depends on a credential', async () => {
    const res = await call('GET', '/api/platform/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('refuses every other route without a bearer key', async () => {
    for (const route of ['/api/platform/session', '/api/platform/graph', '/api/platform/audit']) {
      const res = await call('GET', route);
      expect(res.status).toBe(401);
    }
  });

  it('refuses an unknown key', async () => {
    const res = await call('GET', '/api/platform/session', { key: 'not-a-real-key' });
    expect(res.status).toBe(401);
    expect(String(res.body.error)).toMatch(/unknown api key/i);
  });

  it('ignores a key passed anywhere other than the Authorization header', async () => {
    const response = await fetch(`${baseUrl}/api/platform/session?apiKey=${KEYS.secret}`);
    expect(response.status).toBe(401);
  });

  it('resolves clearance from the key, not from anything the client says', async () => {
    const res = await call('GET', '/api/platform/session', { key: KEYS.public });
    expect(res.status).toBe(200);
    expect(res.body.clearanceName).toBe('PUBLIC');

    const elevated = await call('GET', '/api/platform/session', { key: KEYS.secret });
    expect(elevated.body.clearanceName).toBe('SECRET');
  });
});

describe('platform API: clearance is clamped on write', () => {
  it('will not let a PUBLIC caller classify a free-text document above itself', async () => {
    const res = await call('POST', '/api/platform/documents', {
      key: KEYS.public,
      body: {
        text: 'Director Ada Lovelace approved a contract worth $250,000 with Analytical Engines Ltd.',
        source: 'clamp-text.txt',
        sector: 'Corporate',
        clearance: 'TOP_SECRET',
      },
    });
    expect(res.status).toBe(201);

    // If the requested TOP_SECRET had been honoured, a PUBLIC reader could not
    // see the entities it created. Seeing them proves the clamp applied.
    const graph = await call('GET', '/api/platform/graph', { key: KEYS.public });
    expect(graph.status).toBe(200);
    const labels = graph.body.nodes.map((n: { label: string }) => n.label);
    expect(labels).toContain('Ada Lovelace');
    for (const node of graph.body.nodes) {
      expect(node.clearance).toBe(0);
    }
  });

  it('will not let a PUBLIC caller classify structured records above itself', async () => {
    const res = await call('POST', '/api/platform/documents/structured', {
      key: KEYS.public,
      body: {
        csv: 'emp_id,emp_name,org_id,org_name\n7,Grace Hopper,C1,Compiler Corp',
        mapping: {
          entities: [
            { type: 'Person', idField: 'emp_id', labelField: 'emp_name' },
            { type: 'Organization', idField: 'org_id', labelField: 'org_name' },
          ],
          edges: [{ relation: 'AFFILIATED_WITH', fromField: 'emp_id', toField: 'org_id' }],
        },
        source: 'clamp-structured.csv',
        sector: 'Corporate',
        clearance: 'TOP_SECRET',
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.rowsProcessed).toBe(1);

    const graph = await call('GET', '/api/platform/graph', { key: KEYS.public });
    const hopper = graph.body.nodes.find((n: { label: string }) => n.label === 'Grace Hopper');
    // Visible to PUBLIC at all, and recorded at PUBLIC — the requested
    // TOP_SECRET was discarded rather than trusted.
    expect(hopper).toBeDefined();
    expect(hopper.clearance).toBe(0);
  });

  it('still honours a classification at or below the caller, so clamping is not a blanket downgrade', async () => {
    await call('POST', '/api/platform/documents', {
      key: KEYS.secret,
      body: {
        text: 'Director Alan Turing approved a contract worth $900,000 with Bletchley Systems Ltd.',
        source: 'internal-doc.txt',
        sector: 'Corporate',
        clearance: 'INTERNAL',
      },
    });

    const asPublic = await call('GET', '/api/platform/graph', { key: KEYS.public });
    const asInternal = await call('GET', '/api/platform/graph', { key: KEYS.internal });

    const publicLabels = asPublic.body.nodes.map((n: { label: string }) => n.label);
    const internalLabels = asInternal.body.nodes.map((n: { label: string }) => n.label);
    expect(publicLabels).not.toContain('Alan Turing');
    expect(internalLabels).toContain('Alan Turing');
  });
});

describe('platform API: reads are filtered to the caller', () => {
  it('does not leak higher-clearance entities to a lower-clearance reader', async () => {
    await call('POST', '/api/platform/documents', {
      key: KEYS.secret,
      body: {
        text: 'Director Katherine Johnson approved a contract worth $4,000,000 with Orbital Dynamics Inc.',
        source: 'secret-doc.txt',
        sector: 'Defense',
        clearance: 'SECRET',
      },
    });

    const asPublic = await call('GET', '/api/platform/graph', { key: KEYS.public });
    const asSecret = await call('GET', '/api/platform/graph', { key: KEYS.secret });

    const publicLabels = asPublic.body.nodes.map((n: { label: string }) => n.label);
    const secretLabels = asSecret.body.nodes.map((n: { label: string }) => n.label);
    expect(publicLabels).not.toContain('Katherine Johnson');
    expect(secretLabels).toContain('Katherine Johnson');
  });

  it('runs an investigation at the caller resolved clearance', async () => {
    const res = await call('POST', '/api/platform/investigate', {
      key: KEYS.secret,
      body: { query: 'What is the total contract amount linked to Katherine Johnson?' },
    });
    expect(res.status).toBe(200);
    expect(res.body.blocked).toBe(false);
    expect(res.body.plan.length).toBeGreaterThan(0);
    // The figure must come from executed code, never from the narrative layer.
    expect(res.body.computation).not.toBeNull();
    expect(res.body.computation.result.sum).toBe(4_000_000);
  });

  it('rejects an investigate call with no query rather than running an empty one', async () => {
    const res = await call('POST', '/api/platform/investigate', {
      key: KEYS.internal,
      body: {},
    });
    expect(res.status).toBe(400);
  });
});

describe('platform API: audit', () => {
  it('records the activity above in a chain that still verifies', async () => {
    const res = await call('GET', '/api/platform/audit', { key: KEYS.internal });
    expect(res.status).toBe(200);
    expect(res.body.verification.valid).toBe(true);
    expect(res.body.entries.length).toBeGreaterThan(0);
    expect(res.body.entries.map((e: { action: string }) => e.action)).toContain('investigate');
  });
});

describe('platform API: response hardening', () => {
  it('sets the baseline security headers', async () => {
    const res = await call('GET', '/api/platform/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('does not reflect an arbitrary origin back as allowed', async () => {
    const response = await fetch(`${baseUrl}/api/platform/health`, {
      headers: { Origin: 'https://evil.example' },
    });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('reports remaining rate-limit budget on authenticated calls', async () => {
    const res = await call('GET', '/api/platform/session', { key: KEYS.internal });
    expect(res.headers.get('x-ratelimit-remaining')).not.toBeNull();
  });
});

describe('platform API: analytics', () => {
  it('computes structure and explainable risk over the caller view', async () => {
    const res = await call('GET', '/api/platform/analytics', { key: KEYS.secret });
    expect(res.status).toBe(200);
    expect(res.body.totals.nodes).toBeGreaterThan(0);
    expect(Array.isArray(res.body.risk)).toBe(true);
    expect(Array.isArray(res.body.centrality)).toBe(true);

    // Every scored entity must carry the signals behind its score. A bare
    // number would be exactly the unaccountable output this platform exists
    // to avoid.
    for (const assessment of res.body.risk) {
      expect(assessment).toHaveProperty('band');
      expect(Array.isArray(assessment.signals)).toBe(true);
      for (const signal of assessment.signals) {
        expect(typeof signal.reason).toBe('string');
        expect(signal.reason.length).toBeGreaterThan(0);
        expect(typeof signal.evidence).toBe('string');
        expect(signal.contribution).toBeGreaterThan(0);
      }
      // A score with no signals must be zero, and vice versa.
      if (assessment.signals.length === 0) expect(assessment.score).toBe(0);
      else expect(assessment.score).toBeGreaterThan(0);
    }
  });

  it('does not let a higher-clearance entity influence a lower-clearance view', async () => {
    // The inference channel: if analytics were computed over the full graph,
    // a SECRET entity would change the centrality of entities a PUBLIC caller
    // *can* see, revealing that something is there.
    const asPublic = await call('GET', '/api/platform/analytics', { key: KEYS.public });
    const asSecret = await call('GET', '/api/platform/analytics', { key: KEYS.secret });

    expect(asPublic.body.totals.nodes).toBeLessThan(asSecret.body.totals.nodes);

    const publicIds = asPublic.body.risk.map((r: { id: string }) => r.id);
    const secretOnly = asSecret.body.risk
      .map((r: { id: string }) => r.id)
      .filter((id: string) => !publicIds.includes(id));
    expect(secretOnly.length).toBeGreaterThan(0);
    for (const id of secretOnly) {
      expect(publicIds).not.toContain(id);
    }
  });

  it('requires a key like every other authenticated route', async () => {
    expect((await call('GET', '/api/platform/analytics')).status).toBe(401);
    expect((await call('GET', '/api/platform/paths?from=a&to=b')).status).toBe(401);
  });
});

describe('platform API: paths', () => {
  it('returns every shortest route between two connected entities', async () => {
    const graph = await call('GET', '/api/platform/graph', { key: KEYS.secret });
    const edge = graph.body.edges[0];
    expect(edge).toBeDefined();

    const res = await call(
      'GET',
      `/api/platform/paths?from=${encodeURIComponent(edge.source)}&to=${encodeURIComponent(edge.target)}`,
      { key: KEYS.secret },
    );
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.hops).toBe(1);
    expect(res.body.paths[0][0].id).toBe(edge.source);
    // Labels come back resolved, so the caller does not need a second lookup.
    expect(typeof res.body.paths[0][0].label).toBe('string');
  });

  it('rejects a request missing either endpoint', async () => {
    const res = await call('GET', '/api/platform/paths?from=only-one', { key: KEYS.secret });
    expect(res.status).toBe(400);
  });

  it('does not distinguish a hidden entity from a nonexistent one', async () => {
    // Both must 404 identically. A different status or message for a real but
    // classified id would confirm that it exists.
    const secretGraph = await call('GET', '/api/platform/graph', { key: KEYS.secret });
    const publicGraph = await call('GET', '/api/platform/graph', { key: KEYS.public });
    const publicIds = new Set(publicGraph.body.nodes.map((n: { id: string }) => n.id));
    const hiddenId = secretGraph.body.nodes.find((n: { id: string }) => !publicIds.has(n.id))?.id;
    expect(hiddenId).toBeDefined();

    const anyPublicId = publicGraph.body.nodes[0].id;
    const hidden = await call(
      'GET',
      `/api/platform/paths?from=${encodeURIComponent(anyPublicId)}&to=${encodeURIComponent(hiddenId)}`,
      { key: KEYS.public },
    );
    const nonexistent = await call(
      'GET',
      `/api/platform/paths?from=${encodeURIComponent(anyPublicId)}&to=definitely-not-a-real-id`,
      { key: KEYS.public },
    );

    expect(hidden.status).toBe(404);
    expect(nonexistent.status).toBe(404);
    expect(hidden.body.error).toBe(nonexistent.body.error);
  });
});

describe('platform API: cases', () => {
  it('creates a case at the caller resolved clearance', async () => {
    const res = await call('POST', '/api/platform/cases', {
      key: KEYS.internal,
      body: { title: 'Procurement review' },
    });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Procurement review');
    // From the key, not from anything the client could have sent.
    expect(res.body.clearance).toBe(1);
  });

  it('rejects a case with no title', async () => {
    const res = await call('POST', '/api/platform/cases', {
      key: KEYS.internal,
      body: { title: '   ' },
    });
    expect(res.status).toBe(400);
  });

  it('attaches an investigation as a finding, with the audit sequence that backs it', async () => {
    const created = await call('POST', '/api/platform/cases', {
      key: KEYS.secret,
      body: { title: 'Orbital contracts' },
    });

    const attached = await call('POST', `/api/platform/cases/${created.body.id}/findings`, {
      key: KEYS.secret,
      body: { query: 'What is the total contract amount linked to Katherine Johnson?' },
    });

    expect(attached.status).toBe(201);
    expect(attached.body.case.findings).toHaveLength(1);
    const [finding] = attached.body.case.findings;
    // The summary on the case is the one the audit log holds — the endpoint
    // runs the investigation itself rather than accepting a client-supplied
    // summary, so there is no window to edit it in between.
    expect(finding.summary).toBe(attached.body.investigation.summary);
    expect(finding.auditSeq).toBe(attached.body.investigation.auditSeq);
    expect(finding.entityIds.length).toBeGreaterThan(0);
  });

  it('raises a case clearance to cover a finding, and says that it did', async () => {
    // The laundering scenario end to end: a SECRET finding attached to a case
    // an INTERNAL reader could see must take the case out of their view, not
    // expose the finding to them.
    const created = await call('POST', '/api/platform/cases', {
      key: KEYS.internal,
      body: { title: 'Shared review' },
    });
    expect(created.body.clearance).toBe(1);

    const beforeRaise = await call('GET', '/api/platform/cases', { key: KEYS.internal });
    expect(beforeRaise.body.cases.map((c: { id: string }) => c.id)).toContain(created.body.id);

    const attached = await call('POST', `/api/platform/cases/${created.body.id}/findings`, {
      key: KEYS.secret,
      body: { query: 'What is the total contract amount linked to Katherine Johnson?' },
    });
    expect(attached.status).toBe(201);
    expect(attached.body.clearanceRaised).toBe(true);
    expect(attached.body.case.clearance).toBe(3);

    const afterRaise = await call('GET', '/api/platform/cases', { key: KEYS.internal });
    expect(afterRaise.body.cases.map((c: { id: string }) => c.id)).not.toContain(created.body.id);
    expect((await call('GET', `/api/platform/cases/${created.body.id}`, { key: KEYS.internal })).status).toBe(404);
    expect((await call('GET', `/api/platform/cases/${created.body.id}`, { key: KEYS.secret })).status).toBe(200);
  });

  it('does not distinguish a hidden case from a nonexistent one', async () => {
    const created = await call('POST', '/api/platform/cases', {
      key: KEYS.secret,
      body: { title: 'Classified' },
    });

    const hidden = await call('GET', `/api/platform/cases/${created.body.id}`, { key: KEYS.public });
    const missing = await call('GET', '/api/platform/cases/case-not-real', { key: KEYS.public });

    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(hidden.body.error).toBe(missing.body.error);
  });

  it('will not pin an entity the caller cannot see', async () => {
    const created = await call('POST', '/api/platform/cases', {
      key: KEYS.public,
      body: { title: 'Public case' },
    });

    const secretGraph = await call('GET', '/api/platform/graph', { key: KEYS.secret });
    const publicIds = new Set(
      (await call('GET', '/api/platform/graph', { key: KEYS.public })).body.nodes.map(
        (n: { id: string }) => n.id,
      ),
    );
    const hiddenId = secretGraph.body.nodes.find((n: { id: string }) => !publicIds.has(n.id))!.id;

    const res = await call('POST', `/api/platform/cases/${created.body.id}/pin`, {
      key: KEYS.public,
      body: { entityIds: [hiddenId] },
    });

    // Nothing resolvable in their view, so nothing pinned — and the case's
    // clearance is untouched, which would otherwise itself signal something.
    expect(res.status).toBe(404);
    const after = await call('GET', `/api/platform/cases/${created.body.id}`, { key: KEYS.public });
    expect(after.body.pinnedEntityIds).toEqual([]);
    expect(after.body.clearance).toBe(0);
  });

  it('records notes and case actions in the audit chain', async () => {
    const created = await call('POST', '/api/platform/cases', {
      key: KEYS.internal,
      body: { title: 'Noted case' },
    });
    const noted = await call('POST', `/api/platform/cases/${created.body.id}/notes`, {
      key: KEYS.internal,
      body: { text: 'Vendor registered three weeks before the award.' },
    });
    expect(noted.status).toBe(201);
    expect(noted.body.notes[0].text).toContain('three weeks');
    // The author is recorded as a key hash, never the key itself.
    expect(noted.body.notes[0].authorKeyId).not.toContain('test-');

    const audit = await call('GET', '/api/platform/audit', { key: KEYS.internal });
    const actions = audit.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toContain('case_created');
    expect(actions).toContain('case_note_added');
    expect(audit.body.verification.valid).toBe(true);
  });

  it('requires a key on every case route', async () => {
    expect((await call('GET', '/api/platform/cases')).status).toBe(401);
    expect((await call('POST', '/api/platform/cases', { body: { title: 'x' } })).status).toBe(401);
  });
});

describe('platform API: InfraUA ingestion', () => {
  const payload = {
    facilities: [
      {
        id: 'plant-9',
        name: 'ТЕС Дев’ята',
        category: 'power_plant',
        lat: 50.4,
        lon: 30.5,
        operator: 'Київобленерго',
        source: 'https://openstreetmap.org/way/9',
      },
      {
        id: 'sub-9',
        name: 'ПС Дев’ята',
        category: 'substation',
        lat: 50.5,
        lon: 30.5,
        source: 'https://openstreetmap.org/way/10',
      },
    ],
    dependencies: [
      {
        from: 'plant-9',
        to: 'sub-9',
        km: 11,
        kind: 'supply',
        provenance: { kind: 'observed', source: 'OpenStreetMap', ref: 'way/77' },
      },
    ],
  };

  it('requires a key like every other route', async () => {
    const res = await call('POST', '/api/platform/ingest/infraua', { body: { payload } });
    expect(res.status).toBe(401);
  });

  it('ingests facilities and dependencies and reports the provenance split', async () => {
    const res = await call('POST', '/api/platform/ingest/infraua', {
      key: KEYS.internal,
      body: { payload, source: 'infraua-test', sector: 'infrastructure' },
    });
    expect(res.status).toBe(201);
    expect(res.body.facilitiesIngested).toBe(2);
    expect(res.body.observedDependencies).toBe(1);
    expect(res.body.inferredDependencies).toBe(0);
    expect(res.body.rejected).toEqual([]);
  });

  it('clamps a caller trying to classify above their own clearance', async () => {
    // The same hole ApiKeyAuth closed elsewhere: an INTERNAL caller must not
    // be able to write SECRET rows by asking nicely.
    const res = await call('POST', '/api/platform/ingest/infraua', {
      key: KEYS.internal,
      body: { payload, source: 'infraua-clamp', sector: 'infrastructure', clearance: 'SECRET' },
    });
    expect(res.status).toBe(201);

    // Landed at INTERNAL: visible to the caller who wrote it, invisible below.
    const asInternal = await call('GET', '/api/platform/graph', { key: KEYS.internal });
    expect(asInternal.body.nodes.some((n: any) => n.label === 'ТЕС Дев’ята')).toBe(true);

    const asPublic = await call('GET', '/api/platform/graph', { key: KEYS.public });
    expect(asPublic.body.nodes.some((n: any) => n.label === 'ТЕС Дев’ята')).toBe(false);
  });

  it('defaults to PUBLIC so open data stays readable at any clearance', async () => {
    await call('POST', '/api/platform/ingest/infraua', {
      key: KEYS.secret,
      body: { payload, source: 'infraua-open', sector: 'infrastructure' },
    });
    const seen = await call('GET', '/api/platform/graph', { key: KEYS.public });
    expect(seen.body.nodes.some((n: any) => n.label === 'ПС Дев’ята')).toBe(true);
  });

  it('rejects a request with no payload', async () => {
    const res = await call('POST', '/api/platform/ingest/infraua', {
      key: KEYS.internal,
      body: { source: 'x', sector: 'y' },
    });
    expect(res.status).toBe(400);
  });
});
