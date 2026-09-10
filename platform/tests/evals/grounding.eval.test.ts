import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { GraphStore } from '../../core/graph/GraphStore';
import { OntologyManifest } from '../../core/graph/OntologyManifest';
import { VectorIndex } from '../../core/vector/VectorIndex';
import { AuditLog } from '../../core/audit/AuditLog';
import { InvestigatorAgent } from '../../agents/analyst/InvestigatorAgent';
import { NarrativeAdapter, NarrativeInput } from '../../agents/analyst/narrative/NarrativeAdapter';
import { checkGrounding } from '../../agents/analyst/narrative/GroundingValidator';
import { InfraUAConnector } from '../../core/ingestion/InfraUAConnector';
import { ProzorroConnector } from '../../core/ingestion/ProzorroConnector';
import { ClearanceLevel } from '../../core/security/Clearance';

const CONFIG = path.join(__dirname, '..', '..', 'config');

/**
 * A regression metric for fabrication, not a demonstration that it works.
 *
 * `GroundingValidator` is the thing that makes it safe to let a language model
 * write the prose at all: any number above a small structural threshold has to
 * trace back to an executed computation or a graph property, and any
 * multi-word capitalised phrase has to match a known label. A validator like
 * that has two failure directions and only one of them is visible in normal
 * use - a false rejection just means a plainer answer, while a false
 * acceptance means a fabricated one that nobody notices.
 *
 * So this suite drives the validator from both sides on a fixed corpus:
 * narratives that stay inside the evidence must be accepted, and each
 * *category* of fabrication must be caught. It is written as a table so a new
 * failure mode is a row rather than a new test, and so the pass rate is a
 * number that can be watched rather than an impression.
 */

/** A narrator that says exactly what it is told to, so the validator is what is under test. */
class ScriptedNarrator implements NarrativeAdapter {
  readonly name = 'scripted';
  constructor(private readonly text: string) {}
  async synthesize(): Promise<string> {
    return this.text;
  }
}

interface GroundingCase {
  name: string;
  narrative: (input: NarrativeInput) => string;
  /** Whether a correct validator accepts this. */
  shouldPass: boolean;
  /** What this row is protecting, in one line. */
  because: string;
}

describe('grounding evals', () => {
  let dir: string;
  let graph: GraphStore;
  let vectors: VectorIndex;
  let audit: AuditLog;
  let input: NarrativeInput;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-'));
    graph = new GraphStore(
      path.join(dir, 'graph.json'),
      OntologyManifest.fromFile(path.join(CONFIG, 'ontology.json')),
    );
    vectors = new VectorIndex();
    audit = new AuditLog(path.join(dir, 'audit.log'));

    new InfraUAConnector(graph, vectors, audit).ingest(
      {
        facilities: [
          {
            id: 'eval-plant',
            name: 'Слобідська ТЕС',
            category: 'power_plant',
            lat: 49.9,
            lon: 36.2,
            operator: 'Обленерго Слобідське',
            source: 'https://openstreetmap.org/way/1001',
          },
          {
            id: 'eval-sub',
            name: 'Підстанція Журавлівка',
            category: 'substation',
            lat: 50.0,
            lon: 36.3,
            source: 'https://openstreetmap.org/way/1002',
          },
        ],
        events: [],
        dependencies: [
          {
            from: 'eval-plant',
            to: 'eval-sub',
            km: 14,
            kind: 'supply',
            provenance: {
              kind: 'observed',
              source: 'OpenStreetMap',
              retrievedAt: '2026-09-10',
            },
          },
        ],
      },
      'eval-infra',
      'infrastructure',
      ClearanceLevel.PUBLIC,
    );

    new ProzorroConnector(graph, vectors, audit).ingest(
      [
        {
          tenderID: 'UA-EVAL-1',
          title: 'Ремонт трансформатора',
          procuringEntity: { identifier: { id: '30000001', legalName: 'Обленерго Слобідське' } },
          awards: [
            {
              status: 'active',
              value: { amount: 2_400_000, currency: 'UAH' },
              suppliers: [{ identifier: { id: '30000002', legalName: 'ТОВ Ремонтник' } }],
            },
          ],
        },
      ],
      'eval-prozorro',
    );

    // The real investigation, so the evidence set is the one the pipeline
    // actually produces rather than one assembled for the test.
    const investigator = new InvestigatorAgent(graph, vectors, audit, path.join(dir, 'sandbox'));
    const investigation = await investigator.investigate('Підстанція Журавлівка', ClearanceLevel.PUBLIC);
    input = {
      query: investigation.query,
      hits: [],
      subgraphNodeCount: investigation.subgraph.nodes.length,
      subgraph: investigation.subgraph,
      computation: null,
    };
    expect(input.subgraph.nodes.length).toBeGreaterThan(0);
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const cases: GroundingCase[] = [
    {
      name: 'restates what the evidence contains',
      shouldPass: true,
      because: 'A validator that rejects a correct answer makes the whole generative path useless.',
      narrative: (i) => `Знайдено ${i.subgraph.nodes.length} сутностей навколо запиту.`,
    },
    {
      name: 'names an entity that is in the subgraph',
      shouldPass: true,
      because: 'Labels from the evidence are exactly what a narrative is supposed to use.',
      narrative: (i) => `У підграфі: ${i.subgraph.nodes.map((n) => n.label).join(', ')}.`,
    },
    {
      name: 'invents a monetary figure',
      shouldPass: false,
      because: 'A number with no source is the fabrication that costs the most when acted on.',
      narrative: () => 'Загальна сума договорів становить 87 450 000 гривень.',
    },
    {
      name: 'invents an organisation',
      shouldPass: false,
      because: 'A named party nobody filed is an accusation the data does not support.',
      narrative: () => 'Роботи виконувала Northern Grid Holdings за посередництва Baltic Trade Union.',
    },
    {
      name: 'invents a count that contradicts the evidence',
      shouldPass: false,
      because: 'Getting the size of the finding wrong misleads exactly as much as inventing one.',
      narrative: () => 'Обстежено 4271 обʼєкт і виявлено 318 залежностей.',
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.shouldPass ? 'accepts' : 'rejects'}: ${testCase.name}`, () => {
      const check = checkGrounding(testCase.narrative(input), input);
      expect(check.grounded).toBe(testCase.shouldPass);
      if (!testCase.shouldPass) expect(check.reason).toBeTruthy();
    });
  }

  it('holds a perfect score on the suite, and reports it as a number', () => {
    // Written as a rate rather than a pass/fail so a regression shows as a
    // drop that can be watched, not as one red test among many.
    const passed = cases.filter((c) => checkGrounding(c.narrative(input), input).grounded === c.shouldPass);
    const rate = passed.length / cases.length;
    expect(rate).toBe(1);
  });

  it('falls back to the plain answer rather than surfacing a fabricated one', async () => {
    // The property that makes the generative path safe end to end: a narrator
    // that fabricates does not get its output shown, it gets replaced.
    const investigator = new InvestigatorAgent(
      graph,
      vectors,
      audit,
      path.join(dir, 'sandbox'),
      undefined,
      new ScriptedNarrator('Загальна сума договорів становить 87 450 000 гривень.'),
    );
    const result = await investigator.investigate('Підстанція Журавлівка', ClearanceLevel.PUBLIC);

    expect(result.summary).not.toContain('87 450 000');
    expect(result.narrativeSource).not.toBe('scripted');

    // And the rejection is on the record, with its reason: a fallback nobody
    // can see is indistinguishable from a narrator that never misbehaved.
    const entry = audit.all().reverse().find((e) => e.action === 'investigate')!;
    expect((entry.details as { narrativeRejectionReason?: string }).narrativeRejectionReason).toBeTruthy();
  });

  it('lets a faithful narrator through unchanged', async () => {
    const investigator = new InvestigatorAgent(
      graph,
      vectors,
      audit,
      path.join(dir, 'sandbox'),
      undefined,
      new ScriptedNarrator('Підстанція Журавлівка живиться від Слобідська ТЕС.'),
    );
    const result = await investigator.investigate('Підстанція Журавлівка', ClearanceLevel.PUBLIC);
    expect(result.narrativeSource).toBe('scripted');
    expect(result.summary).toContain('Журавлівка');
  });
});
