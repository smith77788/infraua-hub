import 'dotenv/config';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { GraphStore } from '../core/graph/GraphStore';
import { RevisionLog } from '../core/graph/RevisionLog';
import { OntologyManifest } from '../core/graph/OntologyManifest';
import { VectorIndex } from '../core/vector/VectorIndex';
import { AuditLog } from '../core/audit/AuditLog';
import { DocumentStore } from '../core/ingestion/DocumentStore';
import { IngestionService } from '../core/ingestion/IngestionService';
import { StructuredRecordConnector, StructuredMapping } from '../core/ingestion/StructuredRecordConnector';
import { InfraUAConnector, InfraUAPayload } from '../core/ingestion/InfraUAConnector';
import { ProzorroConnector, ProzorroTender } from '../core/ingestion/ProzorroConnector';
import { ProzorroClient } from '../core/ingestion/ProzorroClient';
import { EdrConnector, PERSONAL_DATA_COMPARTMENT, parseEdrBytes } from '../core/ingestion/EdrConnector';
import { parseCsv } from '../core/ingestion/csv';
import { InvestigatorAgent } from '../agents/analyst/InvestigatorAgent';
import { ClearanceLevel, clearanceAtLeast, parseClearance } from '../core/security/Clearance';
import { canRead, normalizeCompartments, unionCompartments, Viewer } from '../core/security/Marking';
import { Guardrails } from '../core/security/Guardrails';
import { PurposePolicy } from '../core/security/PurposePolicy';
import { EnvApiKeyAuth, Principal } from '../core/security/ApiKeyAuth';
import { RateLimiter } from '../core/security/RateLimiter';
import { RiskScorer } from '../core/analytics/RiskScorer';
import { betweenness, components, degrees, allShortestPaths } from '../core/analytics/GraphMetrics';
import { resolveDuplicates } from '../core/analytics/EntityResolver';
import { findCommonOwnership, findConflictsOfInterest } from '../core/analytics/ConflictOfInterest';
import { CaseStore } from '../core/cases/CaseStore';
import { AlertStore, AlertState } from '../core/alerts/AlertStore';
import { AlertEngine } from '../core/alerts/AlertEngine';
import { AlertSeverity, parseRule } from '../core/alerts/AlertRule';
import { ActionRegistry } from '../core/actions/ActionRegistry';
import { ActionError } from '../core/actions/Action';
import { ToolRegistry } from '../agents/analyst/tools/ToolRegistry';
import { ToolError } from '../agents/analyst/tools/Tool';
import { builtInTools } from '../agents/analyst/tools/tools';
import { DeterministicNarrativeAdapter } from '../agents/analyst/narrative/DeterministicNarrativeAdapter';
import { ClaudeNarrativeAdapter } from '../agents/analyst/narrative/ClaudeNarrativeAdapter';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      callerClearance?: ClearanceLevel;
      callerKeyId?: string;
      /** Who the key belongs to, and what they are read into. */
      principal?: Principal;
      /** The view every read on this request is filtered through. */
      viewer?: Viewer;
      /** The reason the caller declared for this request, recorded with it. */
      accessPurpose?: string | null;
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
const purposePolicy = PurposePolicy.fromFile(path.join(CONFIG_ROOT, 'security_policies.json'));
const riskScorer = RiskScorer.fromFile(path.join(CONFIG_ROOT, 'risk_signals.json'));
const apiKeyAuth = EnvApiKeyAuth.fromEnv();
const revisions = new RevisionLog(path.join(DATA_ROOT, 'revisions.log'));
const graph = new GraphStore(path.join(DATA_ROOT, 'graph.json'), ontology, revisions);
const vectors = new VectorIndex();
const audit = new AuditLog(path.join(DATA_ROOT, 'audit.log'));
const documents = new DocumentStore(path.join(DATA_ROOT, 'documents.json'));
const cases = new CaseStore(path.join(DATA_ROOT, 'cases.json'));
const alerts = new AlertStore(path.join(DATA_ROOT, 'alerts.json'));
const actions = new ActionRegistry(graph, audit, path.join(DATA_ROOT, 'pending-actions.json'));
const tools = new ToolRegistry(
  graph,
  vectors,
  audit,
  path.join(DATA_ROOT, 'sandbox'),
  builtInTools(riskScorer)
);
const alertEngine = new AlertEngine(
  graph,
  alerts,
  riskScorer,
  audit,
  AlertEngine.rulesFromFile(path.join(CONFIG_ROOT, 'alert_rules.json'))
);
for (const doc of documents.loadAll()) vectors.addDocument(doc);

const ingestion = new IngestionService(graph, vectors, audit);
const structuredConnector = new StructuredRecordConnector(graph, vectors, audit);
const infraUA = new InfraUAConnector(graph, vectors, audit);
const prozorro = new ProzorroConnector(graph, vectors, audit);
const prozorroClient = new ProzorroClient(process.env.PROZORRO_API_URL);
const edr = new EdrConnector(graph, vectors, audit);
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
    standing_rules: alertEngine.listRules().filter((r) => r.enabled).length,
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
  let principal: Principal | null;
  try {
    principal = apiKeyAuth.resolvePrincipal(key);
  } catch (err) {
    // A key whose configuration does not parse must be refused, not silently
    // downgraded to "no compartments" - that would widen the key rather than
    // reject it, which is the wrong direction for a configuration error.
    console.error('Rejecting a key with malformed configuration:', err instanceof Error ? err.message : err);
    res.status(401).json({ error: 'Key configuration is invalid.' });
    return;
  }
  if (principal === null) {
    res.status(401).json({ error: 'Unknown API key.' });
    return;
  }
  req.principal = principal;
  req.viewer = EnvApiKeyAuth.viewerOf(principal);
  req.callerClearance = principal.clearance;
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

  const purposeCheck = purposePolicy.check(req.header('x-access-purpose') ?? undefined, principal.purposes);
  if (!purposeCheck.allowed) {
    // Refused accesses are recorded too. A trail that holds only the successful
    // ones cannot show an attempt to reach outside a remit, which is exactly
    // the pattern a purpose is there to make visible.
    audit.append(principal.id, 'access_refused', {
      route: routeOf(req),
      method: req.method,
      declaredPurpose: req.header('x-access-purpose') ?? null,
      reason: purposeCheck.reason,
    });
    res.status(purposeCheck.status ?? 403).json({ error: purposeCheck.reason });
    return;
  }
  req.accessPurpose = purposeCheck.purpose;

  next();
}

/**
 * The route pattern, never the concrete path.
 *
 * `/api/platform/cases/case-3f9a.../findings` in an audit line would put a case
 * id - and with query strings, a search term - into a log that is read by more
 * people than the data it describes. The pattern says which capability was
 * used, which is what the trail is for; the ids belong in the entry the handler
 * writes itself, under the classification of the thing it touched.
 */
function routeOf(req: Request): string {
  const base = req.baseUrl ?? '';
  const route = (req.route as { path?: string } | undefined)?.path;
  if (typeof route === 'string') return `${base}${route}`;
  return `${base}${req.path.split('?')[0]}`;
}

/**
 * Records what each read returned.
 *
 * Until now the chain held what agents *did* and nothing about what people
 * *saw*: `GET /api/platform/graph` left no trace at all, so "who exported the
 * substation list, and under what remit" had no answer. That question is the
 * one an audit trail in this domain exists to answer, and it cannot be
 * reconstructed after the fact from anything else.
 *
 * What is recorded is the shape of the answer - counts, route, purpose, the
 * view it was filtered through - and never the answer itself. A trail that
 * copies the data it describes is a second, less protected copy of that data.
 */
function auditReads(req: Request, res: Response, next: NextFunction): void {
  const originalJson = res.json.bind(res);
  let recorded = false;

  res.json = (body: unknown) => {
    if (!recorded) {
      recorded = true;
      const principal = req.principal;
      if (principal) {
        audit.append(principal.id, 'read_access', {
          route: routeOf(req),
          method: req.method,
          status: res.statusCode,
          purpose: req.accessPurpose ?? null,
          clearance: principal.clearance,
          compartments: principal.compartments,
          returned: describeResult(body),
        });
      }
    }
    return originalJson(body);
  };
  next();
}

/** Counts, never content: how much came back, of what. */
function describeResult(body: unknown): Record<string, number> {
  if (body === null || typeof body !== 'object') return {};
  const record = body as Record<string, unknown>;
  const counts: Record<string, number> = {};
  for (const key of ['nodes', 'edges', 'cases', 'entries', 'paths', 'risk', 'documentHits', 'findings', 'duplicateCandidates']) {
    const value = record[key];
    if (Array.isArray(value)) counts[key] = value.length;
  }
  const subgraph = record.subgraph as { nodes?: unknown[]; edges?: unknown[] } | undefined;
  if (subgraph && typeof subgraph === 'object') {
    if (Array.isArray(subgraph.nodes)) counts.nodes = subgraph.nodes.length;
    if (Array.isArray(subgraph.edges)) counts.edges = subgraph.edges.length;
  }
  return counts;
}

app.use('/api/platform', requireApiKey);
app.use('/api/platform', auditReads);

/**
 * Resolves the compartments a write may be marked with.
 *
 * A caller may mark data into a circle they are themselves read into, and no
 * other. Two failures are being prevented, and only the first is obvious: a
 * caller inventing a compartment could mark data so that nobody at all can
 * read it - a write-only hole in the middle of the graph, indistinguishable
 * from data loss. The second is subtler: marking into a circle you are not in
 * means writing a fact you can never see again to check, which is how a feed
 * quietly poisons a compartment it has no relationship with.
 *
 * Defaults to the caller's own compartments when the request says nothing.
 * That is the fail-closed direction: a principal working inside a circle
 * ingests into that circle unless they deliberately say otherwise.
 */
function resolveWriteCompartments(req: Request): { compartments: string[] } | { error: string } {
  const principal = req.principal!;
  const raw = (req.body ?? {}).compartments;
  if (raw === undefined) return { compartments: principal.compartments };

  let requested: string[];
  try {
    requested = normalizeCompartments(raw);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  const held = new Set(principal.compartments);
  const notHeld = requested.filter((c) => !held.has(c));
  if (notHeld.length > 0) {
    return { error: `You are not read into: ${notHeld.join(', ')}. A write cannot be marked into a compartment you do not hold.` };
  }
  return { compartments: requested };
}

/**
 * Lets the console show the operator which clearance they are actually
 * working at. It is deliberately the *only* way it learns that: the value is
 * derived from the key server-side and never accepted from the client.
 */
app.get('/api/platform/session', (req, res) => {
  const principal = req.principal!;
  res.json({
    principal: principal.id,
    clearance: principal.clearance,
    clearanceName: ClearanceLevel[principal.clearance],
    compartments: principal.compartments,
    purposes: principal.purposes,
    purposeRequired: purposePolicy.isRequired,
    declaredPurposes: purposePolicy.catalogue(),
    activePurpose: req.accessPurpose ?? null,
  });
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
  const marks = resolveWriteCompartments(req);
  if ('error' in marks) return res.status(403).json({ error: marks.error });
  const result = ingestion.ingest(text, source, sector, level, marks.compartments);
  documents.append({
    id: result.documentId,
    text,
    source,
    sector,
    clearance: level,
    ...(marks.compartments.length ? { compartments: marks.compartments } : {}),
  });
  res.status(201).json({ ...result, compartments: marks.compartments, alerts: sweepAfterIngest(req) });
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
    const marks = resolveWriteCompartments(req);
    if ('error' in marks) return res.status(403).json({ error: marks.error });
    const rows: Record<string, string>[] = records ?? parseCsv(csv);
    const result = structuredConnector.ingest(rows, mapping as StructuredMapping, source, sector, level, marks.compartments);
    documents.appendMany(result.documents);
    res.status(201).json({ ...result, compartments: marks.compartments, alerts: sweepAfterIngest(req) });
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
    const marks = resolveWriteCompartments(req);
    if ('error' in marks) return res.status(403).json({ error: marks.error });
    const result = infraUA.ingest(
      payload as InfraUAPayload,
      typeof source === 'string' && source ? source : 'infraua',
      typeof sector === 'string' && sector ? sector : 'infrastructure',
      level,
      marks.compartments
    );
    documents.appendMany(result.documents);
    res.status(201).json({ ...result, compartments: marks.compartments, alerts: sweepAfterIngest(req) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Re-runs the standing queries right after data lands.
 *
 * Evaluating on ingest rather than on a timer is what makes this a standing
 * query instead of a report: the interesting moment is the one where the
 * picture changed, and a poll finds it somewhere between zero and one interval
 * later. Ingests here are batch-sized and human-paced, so there is no sweep
 * storm to debounce; if that ever changes, this is the place to coalesce.
 *
 * A failure here must not fail the ingestion. Data that arrived is data that
 * arrived, and losing it because a rule was malformed would trade a monitoring
 * problem for a data-loss one.
 */
function sweepAfterIngest(req: Request): { raised: number; reopened: number; withheld: number } | { error: string } {
  try {
    const outcome = alertEngine.evaluate(req.principal!.id, req.viewer!);
    return { raised: outcome.raised, reopened: outcome.reopened, withheld: outcome.hidden };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    audit.append(req.principal!.id, 'alerts_sweep_failed', { reason: message });
    return { error: message };
  }
}

/**
 * The triage queue.
 *
 * Alerts are filtered by the reader's own view, exactly like graph nodes: an
 * alert carries the label, the location and the fact that a rule matched, all
 * of which are the disclosure the entity's marking exists to prevent.
 */
app.get('/api/platform/alerts', (req, res) => {
  const state = typeof req.query.state === 'string' ? (req.query.state as AlertState) : undefined;
  if (state && !['new', 'acknowledged', 'resolved'].includes(state)) {
    return res.status(400).json({ error: 'state must be new, acknowledged or resolved' });
  }
  const minSeverity = typeof req.query.minSeverity === 'string' ? (req.query.minSeverity as AlertSeverity) : undefined;
  if (minSeverity && !['info', 'elevated', 'high', 'critical'].includes(minSeverity)) {
    return res.status(400).json({ error: 'minSeverity must be info, elevated, high or critical' });
  }

  const list = alerts.list(req.viewer!, {
    state,
    minSeverity,
    ruleId: typeof req.query.ruleId === 'string' ? req.query.ruleId : undefined,
  });
  res.json({ alerts: list, summary: alerts.summary(req.viewer!) });
});

app.get('/api/platform/alerts/rules', (req, res) => {
  res.json({ rules: alertEngine.listRules(req.viewer!) });
});

/**
 * Adds or replaces a standing query.
 *
 * Gated at CONFIDENTIAL: a rule is not data, it is a decision about what the
 * platform watches for and who gets woken. It is also the one write that can
 * be used to *stop* watching, by replacing a rule with a version that never
 * matches - which is why the previous version is recorded in the audit entry.
 */
app.post('/api/platform/alerts/rules', (req, res) => {
  if (!clearanceAtLeast(req.callerClearance!, ClearanceLevel.CONFIDENTIAL)) {
    return res.status(403).json({ error: 'defining a standing query requires CONFIDENTIAL clearance' });
  }
  try {
    const rule = parseRule(req.body);
    // A rule may not be marked into a circle its author does not hold, for the
    // same reason data may not be: they could not read what it produces.
    const held = new Set(req.principal!.compartments);
    const beyond = rule.compartments.filter((c) => !held.has(c));
    if (beyond.length > 0) {
      return res.status(403).json({ error: `You are not read into: ${beyond.join(', ')}.` });
    }
    if (rule.clearance > req.callerClearance!) {
      return res.status(403).json({ error: 'A rule cannot be classified above its author.' });
    }

    // Looked up across *all* rules, not the caller's view: silently creating a
    // second rule with an id that already exists somewhere they cannot see
    // would leave two versions firing.
    const previous = alertEngine.listRules().find((r) => r.id === rule.id);
    if (previous && !canRead(req.viewer!, { clearance: previous.clearance, compartments: previous.compartments })) {
      return res.status(403).json({ error: `Rule id "${rule.id}" is already in use outside your view.` });
    }
    alertEngine.upsertRule(rule);
    audit.append(req.principal!.id, previous ? 'alert_rule_replaced' : 'alert_rule_created', {
      ruleId: rule.id,
      name: rule.name,
      severity: rule.severity,
      condition: rule.condition,
      previousCondition: previous?.condition ?? null,
      previouslyEnabled: previous?.enabled ?? null,
    });
    res.status(201).json({ rule, replaced: Boolean(previous) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/platform/alerts/evaluate', (req, res) => {
  try {
    const outcome = alertEngine.evaluate(req.principal!.id, req.viewer!);
    res.json(outcome);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Takes ownership of an alert, or closes it.
 *
 * The actor is the principal, not the key hash: a handover has to be able to
 * say who has this one, and a hash cannot be paged.
 */
function moveAlert(to: AlertState) {
  return (req: Request, res: Response) => {
    const note = typeof (req.body ?? {}).note === 'string' ? req.body.note.trim() : undefined;

    const id = String(req.params.id);
    const result = alerts.transition(id, req.viewer!, to, req.principal!.id, note);
    if (result === null) return res.status(404).json({ error: 'No such alert in your view.' });
    if ('error' in result) return res.status(409).json({ error: result.error });

    audit.append(req.principal!.id, 'alert_transitioned', {
      alertId: result.alert.id,
      ruleId: result.alert.ruleId,
      entityId: result.alert.entityId,
      to,
      hasNote: Boolean(note),
    });
    res.json(result.alert);
  };
}

app.post('/api/platform/alerts/:id/acknowledge', moveAlert('acknowledged'));
app.post('/api/platform/alerts/:id/resolve', moveAlert('resolved'));

/**
 * Ingests procurement records already in hand.
 *
 * Separate from the pull below so the mapping can be exercised, replayed and
 * tested without depending on somebody else's service being up - and so an
 * operator holding an export can load it without the platform reaching out at
 * all.
 */
app.post('/api/platform/ingest/prozorro', (req, res) => {
  const { tenders, source, clearance } = req.body ?? {};
  if (!Array.isArray(tenders)) {
    return res.status(400).json({ error: 'tenders must be an array of Prozorro tender records' });
  }
  const callerClearance = req.callerClearance!;
  // Procurement records are published openly, so PUBLIC is the honest default;
  // a deployment that treats the assembled picture as more sensitive than its
  // parts says so in the request, and is still clamped to its own level.
  const level = Math.min(parseClearance(clearance, ClearanceLevel.PUBLIC), callerClearance);
  const marks = resolveWriteCompartments(req);
  if ('error' in marks) return res.status(403).json({ error: marks.error });

  try {
    const result = prozorro.ingest(
      tenders as ProzorroTender[],
      typeof source === 'string' && source ? source : 'prozorro',
      level,
      marks.compartments
    );
    documents.appendMany(result.documents);
    res.status(201).json({ ...result, documents: result.documents.length, alerts: sweepAfterIngest(req) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Pulls a bounded window from the Prozorro change feed and ingests it.
 *
 * Gated at CONFIDENTIAL, which is not about the data - it is public - but
 * about the action: this is the one route that makes the platform originate
 * outbound traffic to a third party under its own name, and that is a
 * different right from reading or loading.
 *
 * The cursor comes back so a later call resumes where this one stopped. There
 * is no timer behind it on purpose: a scheduler needs a lock, and there is no
 * lock across restarts here - two instances walking the same window would
 * double every amount in `value_concentration` with nothing looking wrong.
 */
app.post('/api/platform/ingest/prozorro/pull', async (req, res) => {
  if (!clearanceAtLeast(req.callerClearance!, ClearanceLevel.CONFIDENTIAL)) {
    return res.status(403).json({ error: 'pulling from an external feed requires CONFIDENTIAL clearance' });
  }
  const { maxPages, pageSize, since, maxTenders, offset, source } = req.body ?? {};
  const marks = resolveWriteCompartments(req);
  if ('error' in marks) return res.status(403).json({ error: marks.error });

  try {
    const pull = await prozorroClient.pull(
      {
        maxPages: typeof maxPages === 'number' ? maxPages : undefined,
        pageSize: typeof pageSize === 'number' ? pageSize : undefined,
        maxTenders: typeof maxTenders === 'number' ? maxTenders : undefined,
        since: typeof since === 'string' ? since : undefined,
      },
      typeof offset === 'string' ? offset : undefined
    );
    const result = prozorro.ingest(
      pull.tenders,
      typeof source === 'string' && source ? source : 'prozorro',
      ClearanceLevel.PUBLIC,
      marks.compartments
    );
    documents.appendMany(result.documents);
    audit.append(req.principal!.id, 'prozorro_pull', {
      pagesRead: pull.pagesRead,
      tendersRead: pull.tenders.length,
      failedDetails: pull.failed.length,
      awardsIngested: result.awardsIngested,
    });
    res.status(201).json({
      ...result,
      documents: result.documents.length,
      pagesRead: pull.pagesRead,
      failed: pull.failed,
      nextOffset: pull.nextOffset,
      alerts: sweepAfterIngest(req),
    });
  } catch (err) {
    // A third-party feed being down is not this platform failing.
    res.status(502).json({ error: `Prozorro feed unavailable: ${err instanceof Error ? err.message : String(err)}` });
  }
});

/**
 * The read tools an analyst - or an agent acting for one - may call.
 *
 * The catalogue lists tools the caller cannot use as well, with the level
 * named. Hiding them would leave a planner unable to say "this needs a
 * clearance you do not have", which is a usable answer.
 */
app.get('/api/platform/tools', (req, res) => {
  res.json({ tools: tools.catalogue(req.principal!) });
});

/**
 * Calls one tool.
 *
 * The caller's rights are checked here, on this call, rather than once at the
 * start of a session. With a session-level check the first permitted call
 * opens the door for the rest; with a per-call check a plan does exactly the
 * steps its caller is entitled to and stops at the one it is not.
 *
 * Nothing reachable from here writes. Changing the graph goes through
 * /api/platform/actions, which has preconditions and a two-person rule where
 * it matters - so a planner has no path to a write at all.
 */
app.post('/api/platform/tools/:name', async (req, res) => {
  try {
    const { result, record } = await tools.call(
      String(req.params.name),
      req.body ?? {},
      req.principal!,
      req.viewer!
    );
    res.json({ tool: record.tool, summary: result.summary, data: result.data, shape: result.shape });
  } catch (err) {
    if (err instanceof ToolError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Typed operations that change the graph.
 *
 * Everything that wrote before this came in through ingestion: the platform
 * could be told things by a feed and read by a person, with nothing in
 * between. That left out the whole category of knowledge only a person has -
 * an analyst who has stood in front of a substation knows whether the line
 * into it is real, and had nowhere to say so.
 */
app.get('/api/platform/actions', (req, res) => {
  res.json({ actions: actions.catalogue(req.callerClearance!), pending: actions.listPending() });
});

app.post('/api/platform/actions/:id', (req, res) => {
  try {
    const result = actions.invoke(String(req.params.id), req.body ?? {}, req.principal!, req.viewer!);
    // A two-person action reports 202: it was accepted and has not happened.
    // Returning 200 here would be a lie the caller acts on.
    res.status(result.status === 'pending' ? 202 : 200).json(result);
  } catch (err) {
    if (err instanceof ActionError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/platform/actions/pending/:pendingId/approve', (req, res) => {
  try {
    res.json(actions.approve(String(req.params.pendingId), req.principal!, req.viewer!));
  } catch (err) {
    if (err instanceof ActionError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/platform/actions/pending/:pendingId/withdraw', (req, res) => {
  try {
    res.json({ withdrawn: actions.withdraw(String(req.params.pendingId), req.principal!) });
  } catch (err) {
    if (err instanceof ActionError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Ingests the company register.
 *
 * Takes the published XML as a base64 body rather than JSON records: the file
 * is windows-1251, and asking a caller to transcode it first is asking them to
 * do the one step most likely to go wrong silently. The decoder lives in the
 * connector (`core/ingestion/EdrConnector.ts`) for the same reason.
 *
 * Gated at CONFIDENTIAL. Not because the register is secret - it is open - but
 * because this write creates a graph of **named individuals and their
 * holdings**, which is a different object from a map of substations and should
 * not be creatable with a key issued to read the map.
 */
app.post('/api/platform/ingest/edr', (req, res) => {
  if (!clearanceAtLeast(req.callerClearance!, ClearanceLevel.CONFIDENTIAL)) {
    return res.status(403).json({ error: 'ingesting personal data requires CONFIDENTIAL clearance' });
  }
  const { xmlBase64, source, personCompartments } = req.body ?? {};
  if (typeof xmlBase64 !== 'string' || !xmlBase64) {
    return res.status(400).json({ error: 'xmlBase64 is required: the register file, base64-encoded, as published' });
  }

  const marks = resolveWriteCompartments(req);
  if ('error' in marks) return res.status(403).json({ error: marks.error });

  // Personal data defaults to its own compartment. A caller may name a
  // different one, but only one they hold themselves — the same rule as every
  // other write, and it matters most here.
  let personMarks: string[];
  try {
    personMarks =
      personCompartments === undefined
        ? [PERSONAL_DATA_COMPARTMENT]
        : normalizeCompartments(personCompartments);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
  const held = new Set(req.principal!.compartments);
  const beyond = personMarks.filter((c) => c !== PERSONAL_DATA_COMPARTMENT && !held.has(c));
  if (beyond.length > 0) {
    return res.status(403).json({ error: `You are not read into: ${beyond.join(', ')}.` });
  }

  try {
    const subjects = parseEdrBytes(Buffer.from(xmlBase64, 'base64'));
    const result = edr.ingest(subjects, typeof source === 'string' && source ? source : 'edr', {
      orgCompartments: marks.compartments,
      personCompartments: personMarks,
    });
    documents.appendMany(result.documents);
    res.status(201).json({
      ...result,
      documents: result.documents.length,
      personCompartments: personMarks,
      alerts: sweepAfterIngest(req),
    });
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
      actor: req.principal!.id,
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
    const result = await investigator.investigate(query, req.viewer!);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * The graph, optionally as it stood at a past instant.
 *
 * `?asOf=` is transaction time - what the platform knew then. `?validAt=` is
 * world time - what was true then. Both together answer "what did we believe
 * on the 9th about how the grid stood on the 3rd", which is the question a
 * review of a past decision actually asks and which neither axis answers alone.
 */
app.get('/api/platform/graph', (req, res) => {
  const asOf = typeof req.query.asOf === 'string' ? req.query.asOf : undefined;
  const validAt = typeof req.query.validAt === 'string' ? req.query.validAt : undefined;
  const asOfSeqRaw = typeof req.query.asOfSeq === 'string' ? Number(req.query.asOfSeq) : undefined;
  if (asOfSeqRaw !== undefined && !Number.isInteger(asOfSeqRaw)) {
    return res.status(400).json({ error: 'asOfSeq must be an integer revision sequence' });
  }
  if (!asOf && !validAt && asOfSeqRaw === undefined) {
    // The head cursor comes back on the ordinary read too: a client that
    // cannot name the revision it just saw cannot pin a finding to it, and
    // "the graph as it was when I looked" stops being expressible.
    return res.json({ ...graph.toJSON(req.viewer!), revisionHead: revisions.head() });
  }

  for (const [name, value] of [['asOf', asOf], ['validAt', validAt]] as const) {
    if (value !== undefined && Number.isNaN(Date.parse(value))) {
      return res.status(400).json({ error: `${name} must be an ISO 8601 timestamp` });
    }
  }
  try {
    const result = graph.asOf({ asOf, asOfSeq: asOfSeqRaw, validAt }, req.viewer!);
    // An instant before the journal begins is not an empty world, it is a
    // question this deployment cannot answer - and the difference matters to
    // anyone about to conclude that nothing existed yet.
    const earliest = revisions.earliest();
    res.json({
      ...result,
      historyStartsAt: earliest,
      revisionHead: revisions.head(),
      beforeHistory: Boolean(asOf && earliest && asOf < earliest),
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** What appeared, what went and what moved between two instants. */
app.get('/api/platform/graph/diff', (req, res) => {
  // Accepts either cursor. A sequence is exact; a timestamp cannot separate
  // two changes made in the same millisecond, and ingestion makes many.
  const cursor = (value: unknown, fallback: string | number): string | number | null => {
    if (typeof value !== 'string' || value === '') return fallback;
    if (/^\d+$/.test(value)) return Number(value);
    return Number.isNaN(Date.parse(value)) ? null : value;
  };
  const from = cursor(req.query.from, '');
  const to = cursor(req.query.to, new Date().toISOString());
  if (from === null || to === null || from === '') {
    return res.status(400).json({ error: 'from is required; from and to must each be an ISO 8601 timestamp or a revision sequence' });
  }
  if (typeof from === typeof to && from > to) {
    return res.status(400).json({ error: 'from must not be later than to' });
  }
  try {
    const result = graph.diff(from, to, req.viewer!);
    res.json({
      from,
      to,
      ...result,
      totals: {
        added: result.added.nodes.length + result.added.edges.length,
        removed: result.removed.nodes.length + result.removed.edges.length,
        changed: result.changed.length,
      },
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
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
  const snapshot = graph.toJSON(req.viewer!);
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
    ...(() => {
      const resolution = resolveDuplicates(nodes, edges, { limit: 20 });
      return {
        duplicateCandidates: resolution.candidates,
        // Reported rather than hidden: blocking drops keys that stop
        // discriminating, and an analyst deciding whether the resolver looked
        // hard enough needs to know it stopped looking somewhere.
        resolution: resolution.stats,
      };
    })(),
  });
});

/**
 * Conflicts of interest across procurement and the company register.
 *
 * Kept off `/analytics` deliberately. That endpoint answers "what does this
 * graph look like"; this one answers "who is on both ends of a contract",
 * which is an accusation-shaped question about named people and deserves to be
 * asked on purpose - and to appear in the read audit as its own route.
 *
 * The response separates findings a human has confirmed from questions about
 * identity that nobody has settled yet, and never merges them.
 */
app.get('/api/platform/analytics/conflicts', (req, res) => {
  const { nodes, edges } = graph.toJSON(req.viewer!);
  const minAmount = Number(req.query.minAmount);
  const options = { minAmount: Number.isFinite(minAmount) ? minAmount : 0, limit: 50 };

  const conflicts = findConflictsOfInterest(nodes, edges, options);
  const commonOwnership = findCommonOwnership(nodes, edges, options);

  res.json({
    ...conflicts,
    commonOwnership,
    totals: {
      confirmed: conflicts.confirmed.length,
      unconfirmed: conflicts.unconfirmed.length,
      commonOwnership: commonOwnership.length,
    },
    note:
      'Непідтверджені — це питання про тотожність осіб, а не висновки про них. Тотожність встановлює людина дією link_same_as.',
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

  const { nodes, edges } = graph.toJSON(req.viewer!);
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
  res.json({ cases: cases.list(req.viewer!) });
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
      // always raises it. The same argument carries to need-to-know, and in
      // the same fail-closed direction: an analyst working inside a circle
      // opens cases inside it.
      clearance: req.callerClearance!,
      compartments: req.principal!.compartments,
      createdByKeyId: req.callerKeyId!,
    });
    audit.append('case-store', 'case_created', {
      caseId: created.id,
      title: created.title,
      clearance: created.clearance,
      compartments: created.compartments ?? [],
      actor: req.principal!.id,
      actorKeyId: req.callerKeyId,
    });
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/platform/cases/:id', (req, res) => {
  const found = cases.get(req.params.id, req.viewer!);
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
  const view = req.viewer!;
  const { query } = req.body ?? {};
  if (!query) return res.status(400).json({ error: 'query is required' });
  if (!cases.get(req.params.id, view)) {
    return res.status(404).json({ error: 'No such case in your view.' });
  }

  try {
    const investigation = await investigator.investigate(query, view);
    if (investigation.blocked) {
      return res.status(400).json({ error: investigation.summary, blocked: true });
    }

    // The finding is classified by the highest-classified entity it rests on,
    // so the case's high-water mark covers the evidence and not just the prose.
    const findingClearance = investigation.subgraph.nodes.reduce(
      (highest, node) => Math.max(highest, node.clearance),
      ClearanceLevel.PUBLIC as number
    );
    // Need-to-know travels with the evidence the same way the level does: a
    // finding resting on one compartmented entity is itself in that circle.
    const findingCompartments = unionCompartments(investigation.subgraph.nodes.map((n) => n.compartments));

    const attached = cases.attachFinding(req.params.id, view, {
      auditSeq: investigation.auditSeq,
      // The instant the graph stood at when this was concluded. Without it a
      // finding could not be reproduced: re-running the same query against a
      // graph that had moved on gave a different answer wearing the same
      // provenance.
      graphAsOf: investigation.concludedAt,
      graphRevision: revisions.head(),
      query: investigation.query,
      summary: investigation.summary,
      narrativeSource: investigation.narrativeSource,
      entityIds: investigation.subgraph.nodes.map((n) => n.id),
      clearance: findingClearance,
      ...(findingCompartments.length ? { compartments: findingCompartments } : {}),
    });
    if (!attached) return res.status(404).json({ error: 'No such case in your view.' });

    audit.append('case-store', 'case_finding_attached', {
      caseId: attached.case.id,
      auditSeq: investigation.auditSeq,
      clearanceRaised: attached.clearanceRaised,
      previousClearance: attached.previousClearance,
      newClearance: attached.case.clearance,
      compartmentsAdded: attached.compartmentsAdded,
      actor: req.principal!.id,
      actorKeyId: req.callerKeyId,
    });

    res.status(201).json({
      case: attached.case,
      investigation,
      clearanceRaised: attached.clearanceRaised,
      previousClearance: attached.previousClearance,
      compartmentsAdded: attached.compartmentsAdded,
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
    const updated = cases.addNote(req.params.id, req.viewer!, text, req.callerKeyId!);
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
  const view = req.viewer!;
  const { entityIds } = req.body ?? {};
  if (!Array.isArray(entityIds) || entityIds.length === 0) {
    return res.status(400).json({ error: 'entityIds must be a non-empty array' });
  }

  // Resolve against the caller's own view, so an id they cannot see can never
  // be pinned - and so the classification used for the high-water mark is the
  // real one rather than anything the client asserted.
  const visible = new Map(graph.toJSON(view).nodes.map((n) => [n.id, n]));
  const resolved = entityIds.filter((id: unknown): id is string => typeof id === 'string' && visible.has(id));
  if (resolved.length === 0) {
    return res.status(404).json({ error: 'None of those entities are in your view of the graph.' });
  }

  const entityClearance = resolved.reduce(
    (highest, id) => Math.max(highest, visible.get(id)!.clearance),
    ClearanceLevel.PUBLIC as number
  );
  const entityCompartments = unionCompartments(resolved.map((id) => visible.get(id)!.compartments));

  const pinned = cases.pinEntities(req.params.id, view, resolved, entityClearance, entityCompartments);
  if (!pinned) return res.status(404).json({ error: 'No such case in your view.' });

  audit.append('case-store', 'case_entities_pinned', {
    caseId: pinned.case.id,
    entityIds: resolved,
    clearanceRaised: pinned.clearanceRaised,
    compartmentsAdded: pinned.compartmentsAdded,
    actor: req.principal!.id,
    actorKeyId: req.callerKeyId,
  });

  res.json({
    case: pinned.case,
    pinned: resolved.length,
    ignored: entityIds.length - resolved.length,
    clearanceRaised: pinned.clearanceRaised,
    previousClearance: pinned.previousClearance,
    compartmentsAdded: pinned.compartmentsAdded,
  });
});

/**
 * The chain, paged.
 *
 * `verification` covers the **whole** chain, not the page: a page that
 * verifies while an earlier entry has been altered is a false reassurance, and
 * the point of the hash chain is that tampering anywhere is detectable
 * everywhere after it.
 */
app.get('/api/platform/audit', (req, res) => {
  const num = (value: unknown): number | undefined => {
    const parsed = Number(value);
    return typeof value === 'string' && value !== '' && Number.isFinite(parsed) ? parsed : undefined;
  };
  const page = audit.page({
    limit: num(req.query.limit),
    before: num(req.query.before),
    actor: typeof req.query.actor === 'string' ? req.query.actor : undefined,
    action: typeof req.query.action === 'string' ? req.query.action : undefined,
  });
  res.json({ ...page, verification: audit.verify() });
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

export {
  app,
  graph,
  vectors,
  audit,
  ingestion,
  structuredConnector,
  infraUA,
  prozorro,
  edr,
  investigator,
  cases,
  alerts,
  alertEngine,
  actions,
  tools,
};
