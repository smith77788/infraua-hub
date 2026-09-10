import 'dotenv/config';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { GraphStore } from '../core/graph/GraphStore';
import { OntologyManifest } from '../core/graph/OntologyManifest';
import { VectorIndex } from '../core/vector/VectorIndex';
import { AuditLog } from '../core/audit/AuditLog';
import { DocumentStore } from '../core/ingestion/DocumentStore';
import { IngestionService } from '../core/ingestion/IngestionService';
import { StructuredRecordConnector, StructuredMapping } from '../core/ingestion/StructuredRecordConnector';
import { InfraUAConnector, InfraUAPayload } from '../core/ingestion/InfraUAConnector';
import { parseCsv } from '../core/ingestion/csv';
import { InvestigatorAgent } from '../agents/analyst/InvestigatorAgent';
import { ClearanceLevel, clearanceAtLeast, parseClearance } from '../core/security/Clearance';
import { Guardrails } from '../core/security/Guardrails';
import { EnvApiKeyAuth } from '../core/security/ApiKeyAuth';
import { RateLimiter } from '../core/security/RateLimiter';
import { RiskScorer } from '../core/analytics/RiskScorer';
import { betweenness, components, degrees, allShortestPaths } from '../core/analytics/GraphMetrics';
import { findDuplicateCandidates } from '../core/analytics/EntityResolver';
import { CaseStore } from '../core/cases/CaseStore';
import { DeterministicNarrativeAdapter } from '../agents/analyst/narrative/DeterministicNarrativeAdapter';
import { ClaudeNarrativeAdapter } from '../agents/analyst/narrative/ClaudeNarrativeAdapter';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      callerClearance?: ClearanceLevel;
      callerKeyId?: string;
    }
  }
}

// PLATFORM_PORT is the explicit setting; PORT is what nearly every managed
// host (Railway, Render, Fly, Heroku) injects and does not let you rename, so
// honouring it is the difference between deploying and not.
const PORT = Number(process.env.PLATFORM_PORT ?? process.env.PORT ?? 4500);
// Bind all interfaces by default: a container that listens on localhost is
// unreachable from outside it, which looks exactly like a crashed process.
const HOST = process.env.HOST ?? '0.0.0.0';
// __dirname is platform/api when run from source and platform/dist/api once
// compiled - walk up to platform/ either way, so config and workspace data are
// never read from inside the build output.
//
// The platform used to live in its own repository; it now sits under platform/
// in this one, which is why this probe walks up one level instead of three.
const PLATFORM_ROOT = __dirname.includes(`${path.sep}dist${path.sep}`)
  ? path.join(__dirname, '..', '..')
  : path.join(__dirname, '..');
// PLATFORM_DATA_DIR lets a container mount its state somewhere durable, and
// lets the tests point each run at its own temp directory instead of sharing
// the developer's workspace.
const DATA_ROOT = process.env.PLATFORM_DATA_DIR
  ? path.resolve(process.env.PLATFORM_DATA_DIR)
  : path.join(PLATFORM_ROOT, 'workspace');
const CONFIG_ROOT = path.join(PLATFORM_ROOT, 'config');

const ontology = OntologyManifest.fromFile(path.join(CONFIG_ROOT, 'ontology.json'));
const guardrails = Guardrails.fromFile(path.join(CONFIG_ROOT, 'security_policies.json'));
const riskScorer = RiskScorer.fromFile(path.join(CONFIG_ROOT, 'risk_signals.json'));
const apiKeyAuth = EnvApiKeyAuth.fromEnv();
const graph = new GraphStore(path.join(DATA_ROOT, 'graph.json'), ontology);
const vectors = new VectorIndex();
const audit = new AuditLog(path.join(DATA_ROOT, 'audit.log'));
const documents = new DocumentStore(path.join(DATA_ROOT, 'documents.json'));
const cases = new CaseStore(path.join(DATA_ROOT, 'cases.json'));
for (const doc of documents.loadAll()) vectors.addDocument(doc);

const ingestion = new IngestionService(graph, vectors, audit);
const structuredConnector = new StructuredRecordConnector(graph, vectors, audit);
const infraUA = new InfraUAConnector(graph, vectors, audit);
const narrativeAdapter = process.env.ANTHROPIC_API_KEY
  ? new ClaudeNarrativeAdapter(process.env.ANTHROPIC_API_KEY)
  : new DeterministicNarrativeAdapter();
const investigator = new InvestigatorAgent(graph, vectors, audit, path.join(DATA_ROOT, 'sandbox'), guardrails, narrativeAdapter);
const rateLimiter = RateLimiter.fromEnv();
setInterval(() => rateLimiter.prune(), 60_000).unref();

const app = express();

/**
 * CORS is opt-in, not wide open. The console is normally served by this same
 * server (CONSOLE_DIST below), so no cross-origin request is involved at all;
 * a separately-hosted console must be named explicitly in CORS_ORIGINS. The
 * previous `cors()` with no arguments reflected *any* origin, which on an API
 * that authenticates with a bearer token means any page on the internet could
 * call it with a key it had obtained.
 */
const corsOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  })
);

app.use(express.json({ limit: '5mb' }));

// Baseline response headers. The console is a same-origin SPA with no inline
// scripts, so a restrictive CSP costs nothing here.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});

/**
 * The built console, when one is present next to the API.
 *
 * In this repository the console is a separate deployment with its own build
 * output, so normally nothing is here and the server runs headless as a pure
 * API — which is what the tests use. Serving it from one origin stays possible
 * and is simply not how it is deployed.
 */
const CONSOLE_DIST = path.join(PLATFORM_ROOT, '..', '.output', 'public');
const consoleBuilt = fs.existsSync(path.join(CONSOLE_DIST, 'index.html'));
if (consoleBuilt) {
  app.use(express.static(CONSOLE_DIST, { index: false, maxAge: '1h' }));
}

app.get('/api/platform/health', (_req, res) => {
  res.json({
    status: 'ok',
    documents: vectors.size(),
    nodes: graph.toJSON().nodes.length,
    narrative_engine: narrativeAdapter.name,
  });
});

/**
 * Every /api/platform/* route below this point requires a bearer API
 * key and resolves the caller's clearance from it server-side
 * (core/security/ApiKeyAuth.ts) - a client can no longer just assert
 * "clearance": "TOP_SECRET" in a request body or query string and read
 * data above its actual level, which the previous version of this
 * platform allowed.
 */
function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? '';
  const key = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (!key) {
    res.status(401).json({ error: 'Missing Authorization: Bearer <api-key> header.' });
    return;
  }
  const clearance = apiKeyAuth.resolveClearance(key);
  if (clearance === null) {
    res.status(401).json({ error: 'Unknown API key.' });
    return;
  }
  req.callerClearance = clearance;
  // Identify the caller for rate limiting and audit by a hash of the key, so
  // the raw credential is never held on the request object or logged.
  req.callerKeyId = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);

  const decision = rateLimiter.take(req.callerKeyId);
  if (!decision.allowed) {
    res.setHeader('Retry-After', String(decision.retryAfterSeconds));
    res.status(429).json({
      error: `Rate limit exceeded. Retry in ${decision.retryAfterSeconds}s.`,
    });
    return;
  }
  res.setHeader('X-RateLimit-Remaining', String(decision.remaining));
  next();
}

app.use('/api/platform', requireApiKey);

/**
 * Lets the console show the operator which clearance they are actually
 * working at. It is deliberately the *only* way it learns that: the value is
 * derived from the key server-side and never accepted from the client.
 */
app.get('/api/platform/session', (req, res) => {
  const clearance = req.callerClearance!;
  res.json({ clearance, clearanceName: ClearanceLevel[clearance] });
});

app.post('/api/platform/documents', (req, res) => {
  const { text, source, sector, clearance } = req.body ?? {};
  if (!text || !source || !sector) {
    return res.status(400).json({ error: 'text, source and sector are required' });
  }
  const callerClearance = req.callerClearance!;
  // A caller may mark a document at their own clearance or lower, never higher -
  // otherwise a low-clearance ingester could smuggle a PUBLIC fact in as TOP_SECRET
  // (or, more importantly, the reverse would let them under-classify something
  // they aren't trusted to declassify).
  const requested = parseClearance(clearance, callerClearance);
  const level = Math.min(requested, callerClearance);
  const result = ingestion.ingest(text, source, sector, level);
  documents.append({ id: result.documentId, text, source, sector, clearance: level });
  res.status(201).json(result);
});

app.post('/api/platform/documents/structured', (req, res) => {
  const { mapping, source, sector, clearance, records, csv } = req.body ?? {};
  if (!mapping || !source || !sector) {
    return res.status(400).json({ error: 'mapping, source and sector are required' });
  }
  if ((records && csv) || (!records && !csv)) {
    return res.status(400).json({ error: 'exactly one of records or csv must be provided' });
  }
  // Same clamp as the free-text ingestion path above: a caller may classify at
  // their own clearance or lower, never higher. Without this the structured
  // connector reopens the client-asserted-clearance hole that ApiKeyAuth closed.
  const callerClearance = req.callerClearance!;
  const level = Math.min(parseClearance(clearance, callerClearance), callerClearance);
  try {
    const rows: Record<string, string>[] = records ?? parseCsv(csv);
    const result = structuredConnector.ingest(rows, mapping as StructuredMapping, source, sector, level);
    documents.appendMany(result.documents);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Ingests an InfraUA picture: facilities, their operators, natural events and
 * the power dependencies between them, with each dependency's provenance
 * preserved.
 *
 * Same clearance clamp as every other ingestion path - a caller classifies at
 * their own level or lower, never higher. The default is PUBLIC because the
 * upstream sources (OpenStreetMap, NASA, USGS) are open; a deployment that
 * considers the assembled picture more sensitive than its parts says so
 * explicitly in the request.
 */
app.post('/api/platform/ingest/infraua', (req, res) => {
  const { payload, source, sector, clearance } = req.body ?? {};
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'payload is required' });
  }
  const callerClearance = req.callerClearance!;
  const level = Math.min(parseClearance(clearance, ClearanceLevel.PUBLIC), callerClearance);
  try {
    const result = infraUA.ingest(
      payload as InfraUAPayload,
      typeof source === 'string' && source ? source : 'infraua',
      typeof sector === 'string' && sector ? sector : 'infrastructure',
      level
    );
    documents.appendMany(result.documents);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Retracts an ingestion batch by its source.
 *
 * Destructive, so it is gated at SECRET rather than at the caller's own level:
 * ingesting is routine, taking data back out is not, and the two should not be
 * reachable with the same key. Recorded in the audit chain with what it
 * removed, because "the graph got smaller" is exactly the kind of change
 * nobody can reconstruct afterwards.
 */
app.post('/api/platform/retract', (req, res) => {
  const { source } = req.body ?? {};
  if (typeof source !== 'string' || !source.trim()) {
    return res.status(400).json({ error: 'source is required' });
  }
  if (!clearanceAtLeast(req.callerClearance!, ClearanceLevel.SECRET)) {
    return res.status(403).json({ error: 'retraction requires SECRET clearance' });
  }
  try {
    const name = source.trim();
    const result = graph.retractSource(name);
    // Граф і пошук мають зникати разом: відкликана партія, що лишилася в
    // індексі, — це дані, які оператор вважає прибраними, а пошук їх видає.
    const documentsRemoved = documents.removeBySource(name);
    vectors.removeBySource(name);
    audit.append(name, 'RETRACT_SOURCE', {
      nodesRemoved: result.nodesRemoved.length,
      edgesRemoved: result.edgesRemoved,
      documentsRemoved,
    });
    res.json({ ...result, documentsRemoved });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/platform/investigate', async (req, res) => {
  const { query } = req.body ?? {};
  if (!query) return res.status(400).json({ error: 'query is required' });
  try {
    const result = await investigator.investigate(query, req.callerClearance!);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/platform/graph', (req, res) => {
  res.json(graph.toJSON(req.callerClearance!));
});

/**
 * Structural analysis over the caller's own view of the graph.
 *
 * Every metric is computed from the clearance-filtered snapshot rather than
 * the full store. Centrality derived from nodes the caller cannot see would
 * leak their existence through the scores of the nodes they can - so two
 * analysts at different clearances will legitimately see different numbers,
 * and that is the correct behaviour rather than a bug.
 */
app.get('/api/platform/analytics', (req, res) => {
  const clearance = req.callerClearance!;
  const snapshot = graph.toJSON(clearance);
  const { nodes, edges } = snapshot;

  const risk = riskScorer.score(nodes, edges);
  const componentSizes = components(nodes, edges);

  res.json({
    totals: {
      nodes: nodes.length,
      edges: edges.length,
      components: componentSizes.length,
      largestComponent: componentSizes[0]?.size ?? 0,
      isolated: componentSizes.filter((c) => c.size === 1).length,
    },
    risk: risk.slice(0, 25),
    riskBands: {
      severe: risk.filter((r) => r.band === 'severe').length,
      high: risk.filter((r) => r.band === 'high').length,
      elevated: risk.filter((r) => r.band === 'elevated').length,
      low: risk.filter((r) => r.band === 'low').length,
    },
    centrality: betweenness(nodes, edges).slice(0, 10),
    connectivity: degrees(nodes, edges).slice(0, 10),
    duplicateCandidates: findDuplicateCandidates(nodes, edges, { limit: 20 }),
  });
});

/**
 * How two entities are connected - all equally-short routes, not just one.
 * Showing a single path invites the reading that it is *the* connection.
 */
app.get('/api/platform/paths', (req, res) => {
  const from = typeof req.query.from === 'string' ? req.query.from : '';
  const to = typeof req.query.to === 'string' ? req.query.to : '';
  if (!from || !to) {
    return res.status(400).json({ error: 'from and to query parameters are required' });
  }

  const clearance = req.callerClearance!;
  const { nodes, edges } = graph.toJSON(clearance);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // An id the caller cannot see must not be distinguishable from one that does
  // not exist, or the 404 itself confirms a classified entity.
  if (!byId.has(from) || !byId.has(to)) {
    return res.status(404).json({ error: 'One or both entities are not present in your view of the graph.' });
  }

  const paths = allShortestPaths(nodes, edges, from, to);
  res.json({
    from,
    to,
    connected: paths.length > 0,
    hops: paths.length > 0 ? paths[0].length - 1 : null,
    paths: paths.map((ids) => ids.map((id) => ({ id, label: byId.get(id)?.label ?? id, type: byId.get(id)?.type }))),
  });
});

/**
 * Cases: the durable unit of analyst work.
 *
 * A case's clearance is a high-water mark - it rises to cover whatever is
 * attached and never falls. Without that, a case is a laundering channel: a
 * SECRET finding attached to an INTERNAL case would be readable by every
 * INTERNAL reader with its classification gone. The responses below report
 * `clearanceRaised` so the analyst learns immediately when attaching
 * something narrowed who can read the case.
 */
app.get('/api/platform/cases', (req, res) => {
  res.json({ cases: cases.list(req.callerClearance!) });
});

app.post('/api/platform/cases', (req, res) => {
  const { title } = req.body ?? {};
  if (typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  try {
    const created = cases.create({
      title,
      // A new case starts at the creator's own level, not PUBLIC: it is about
      // to hold their work, and starting low would mean the first attachment
      // always raises it.
      clearance: req.callerClearance!,
      createdByKeyId: req.callerKeyId!,
    });
    audit.append('case-store', 'case_created', {
      caseId: created.id,
      title: created.title,
      clearance: created.clearance,
      actorKeyId: req.callerKeyId,
    });
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/platform/cases/:id', (req, res) => {
  const found = cases.get(req.params.id, req.callerClearance!);
  // Same 404 whether it does not exist or sits above the caller: a distinct
  // status would confirm that a classified case is there.
  if (!found) return res.status(404).json({ error: 'No such case in your view.' });
  res.json(found);
});

/**
 * Runs an investigation and attaches the result to a case in one step, so the
 * finding recorded on the case is exactly the one the audit log holds - there
 * is no window in which a client could edit the summary in between.
 */
app.post('/api/platform/cases/:id/findings', async (req, res) => {
  const clearance = req.callerClearance!;
  const { query } = req.body ?? {};
  if (!query) return res.status(400).json({ error: 'query is required' });
  if (!cases.get(req.params.id, clearance)) {
    return res.status(404).json({ error: 'No such case in your view.' });
  }

  try {
    const investigation = await investigator.investigate(query, clearance);
    if (investigation.blocked) {
      return res.status(400).json({ error: investigation.summary, blocked: true });
    }

    // The finding is classified by the highest-classified entity it rests on,
    // so the case's high-water mark covers the evidence and not just the prose.
    const findingClearance = investigation.subgraph.nodes.reduce(
      (highest, node) => Math.max(highest, node.clearance),
      ClearanceLevel.PUBLIC as number
    );

    const attached = cases.attachFinding(req.params.id, clearance, {
      auditSeq: investigation.auditSeq,
      query: investigation.query,
      summary: investigation.summary,
      narrativeSource: investigation.narrativeSource,
      entityIds: investigation.subgraph.nodes.map((n) => n.id),
      clearance: findingClearance,
    });
    if (!attached) return res.status(404).json({ error: 'No such case in your view.' });

    audit.append('case-store', 'case_finding_attached', {
      caseId: attached.case.id,
      auditSeq: investigation.auditSeq,
      clearanceRaised: attached.clearanceRaised,
      previousClearance: attached.previousClearance,
      newClearance: attached.case.clearance,
      actorKeyId: req.callerKeyId,
    });

    res.status(201).json({
      case: attached.case,
      investigation,
      clearanceRaised: attached.clearanceRaised,
      previousClearance: attached.previousClearance,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/platform/cases/:id/notes', (req, res) => {
  const { text } = req.body ?? {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  try {
    const updated = cases.addNote(req.params.id, req.callerClearance!, text, req.callerKeyId!);
    if (!updated) return res.status(404).json({ error: 'No such case in your view.' });
    audit.append('case-store', 'case_note_added', {
      caseId: updated.id,
      actorKeyId: req.callerKeyId,
    });
    res.status(201).json(updated);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/platform/cases/:id/pin', (req, res) => {
  const clearance = req.callerClearance!;
  const { entityIds } = req.body ?? {};
  if (!Array.isArray(entityIds) || entityIds.length === 0) {
    return res.status(400).json({ error: 'entityIds must be a non-empty array' });
  }

  // Resolve against the caller's own view, so an id they cannot see can never
  // be pinned - and so the classification used for the high-water mark is the
  // real one rather than anything the client asserted.
  const visible = new Map(graph.toJSON(clearance).nodes.map((n) => [n.id, n]));
  const resolved = entityIds.filter((id: unknown): id is string => typeof id === 'string' && visible.has(id));
  if (resolved.length === 0) {
    return res.status(404).json({ error: 'None of those entities are in your view of the graph.' });
  }

  const entityClearance = resolved.reduce(
    (highest, id) => Math.max(highest, visible.get(id)!.clearance),
    ClearanceLevel.PUBLIC as number
  );

  const pinned = cases.pinEntities(req.params.id, clearance, resolved, entityClearance);
  if (!pinned) return res.status(404).json({ error: 'No such case in your view.' });

  audit.append('case-store', 'case_entities_pinned', {
    caseId: pinned.case.id,
    entityIds: resolved,
    clearanceRaised: pinned.clearanceRaised,
    actorKeyId: req.callerKeyId,
  });

  res.json({
    case: pinned.case,
    pinned: resolved.length,
    ignored: entityIds.length - resolved.length,
    clearanceRaised: pinned.clearanceRaised,
    previousClearance: pinned.previousClearance,
  });
});

app.get('/api/platform/audit', (_req, res) => {
  res.json({ entries: audit.all(), verification: audit.verify() });
});

/**
 * SPA fallback, last so it can never shadow an API route: any non-/api path
 * that did not match a static file is a client-side route and gets index.html.
 */
if (consoleBuilt) {
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(CONSOLE_DIST, 'index.html'));
  });
}

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Sovereign Analyst Platform API listening on ${HOST}:${PORT}`);
    console.log(
      consoleBuilt
        ? `Console served from ${CONSOLE_DIST}`
        : 'Console not built (run `npm run build`); running as a headless API.'
    );
    if (Object.keys(JSON.parse(process.env.PLATFORM_API_KEYS ?? '{}')).length === 0) {
      console.warn(
        'WARNING: PLATFORM_API_KEYS is empty - every authenticated route will reject with 401. See .env.example.'
      );
    }
  });
}

export { app, graph, vectors, audit, ingestion, structuredConnector, infraUA, investigator, cases };
