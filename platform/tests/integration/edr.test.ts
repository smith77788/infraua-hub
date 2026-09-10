import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { GraphStore } from '../../core/graph/GraphStore';
import { OntologyManifest } from '../../core/graph/OntologyManifest';
import { VectorIndex } from '../../core/vector/VectorIndex';
import { AuditLog } from '../../core/audit/AuditLog';
import {
  EdrConnector,
  PERSONAL_DATA_COMPARTMENT,
  decodeWindows1251,
  parseBeneficiary,
  parseEdrBytes,
  parseFounder,
  parseRegistrationDate,
  parseSigner,
} from '../../core/ingestion/EdrConnector';
import { resolveDuplicates } from '../../core/analytics/EntityResolver';
import { ClearanceLevel } from '../../core/security/Clearance';
import { viewer } from '../../core/security/Marking';

const CONFIG = path.join(__dirname, '..', '..', 'config');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'edr-subjects.xml');

/**
 * Exercised against records taken verbatim from the published register,
 * including its real encoding. Every one of the traps below is a thing the
 * file does and a made-up fixture would not.
 */
describe('the company register', () => {
  let dir: string;
  let graph: GraphStore;
  let vectors: VectorIndex;
  let audit: AuditLog;
  let connector: EdrConnector;
  let bytes: Uint8Array;

  const outsider = viewer(ClearanceLevel.TOP_SECRET, []);
  const insider = viewer(ClearanceLevel.INTERNAL, [PERSONAL_DATA_COMPARTMENT]);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edr-'));
    graph = new GraphStore(
      path.join(dir, 'graph.json'),
      OntologyManifest.fromFile(path.join(CONFIG, 'ontology.json')),
    );
    vectors = new VectorIndex();
    audit = new AuditLog(path.join(dir, 'audit.log'));
    connector = new EdrConnector(graph, vectors, audit);
    bytes = new Uint8Array(fs.readFileSync(FIXTURE));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  describe('encoding', () => {
    it('decodes the register whatever the runtime underneath supports', () => {
      // This assertion used to read `expect(() => new TextDecoder(
      // 'windows-1251')).toThrow()`, which passed locally and broke CI the
      // moment it ran on a newer Bun that has the label. That was a test of
      // the runtime, not of this code - and the lesson is the reason the
      // decoder exists at all: whether a given Node or Bun build carries the
      // ICU tables for this encoding is not something a connector should
      // depend on, and finding out the hard way means mojibake in the graph.
      const subjects = parseEdrBytes(bytes);
      expect(subjects.length).toBeGreaterThan(0);
      const names = subjects.map((s) => s.name ?? '').join(' ');
      expect(names).toMatch(/[А-ЯІЇЄҐа-яіїєґ]/);
      expect(names).not.toContain('\ufffd');
    });

    it('agrees with the platform decoder wherever the platform has one', () => {
      // A real cross-check where it is available, and silently skipped where
      // it is not - rather than an assertion about which runtime this is.
      let platform: TextDecoder;
      try {
        platform = new TextDecoder('windows-1251');
      } catch {
        return;
      }
      const sample = new Uint8Array(256);
      for (let i = 0; i < 256; i++) sample[i] = i;
      expect(decodeWindows1251(sample)).toBe(platform.decode(sample));
    });

    it('maps every byte the way the encoding standard does', () => {
      // The table came from the WHATWG index rather than being typed, and this
      // is what keeps it honest: one wrong entry corrupts a single letter
      // everywhere, silently.
      const all = new Uint8Array(256);
      for (let i = 0; i < 256; i++) all[i] = i;
      const decoded = decodeWindows1251(all);
      expect(decoded).toHaveLength(256);
      expect(decoded.charCodeAt(0x41)).toBe(0x41); // ASCII passes through
      expect(decoded[0xc0 - 0]).toBe('А');
      expect(decoded[0xff]).toBe('я');
      expect(decoded[0xb2]).toBe('І');
      expect(decoded[0xb3]).toBe('і');
      expect(decoded[0xaf]).toBe('Ї');
      expect(decoded[0xbf]).toBe('ї');
      expect(decoded[0xaa]).toBe('Є');
      expect(decoded[0xba]).toBe('є');
      expect(decoded[0xa5]).toBe('Ґ');
      expect(decoded[0xb4]).toBe('ґ');
    });
  });

  describe('parsing the free-text fields', () => {
    it('tells a named owner from a statement that there is none', () => {
      // Both arrive in the same field, and in the real sample the second is
      // most of them. Treating it as a person would put the sentence
      // "Причина відсутності кінцевого бенефіціарного власника" into the
      // graph as a human being.
      const absent = parseBeneficiary(
        'причина відсутності: Причина відсутності кінцевого бенефіціарного власника юридичної особи зазначена у структурі власності',
      );
      expect(absent.name).toBeNull();
      expect(absent.absenceReason).toContain('структурі власності');

      const named = parseBeneficiary('Мхітарян Нвєр; громадянство: Україна; Прямий вирішальний вплив; відсоток частки - 100');
      expect(named.name).toBe('Мхітарян Нвєр');
      expect(named.citizenship).toBe('Україна');
      expect(named.sharePercent).toBe(100);
      expect(named.influence).toContain('вирішальний вплив');
    });

    it('recognises a Ukrainian registry code and refuses to invent one', () => {
      const foreign = parseFounder('КОМПАНІЯ "МУЗАЛЕКС СЕРВІСІЗ ЛІМІТЕД"; HE354216; резиденство: Кіпр');
      expect(foreign.code).toBe('HE354216');
      expect(foreign.country).toBe('Кіпр');
      expect(foreign.ukrainian).toBe(false);

      const domestic = parseFounder('ТОВ "Приклад"; 12345678; резиденство: Україна');
      expect(domestic.ukrainian).toBe(true);
    });

    it('keeps the raw line whatever it managed to parse', () => {
      // A parse that drops what it did not understand leaves an analyst unable
      // to see that anything was dropped.
      const odd = parseFounder('Щось геть незвичне без жодного коду');
      expect(odd.raw).toContain('незвичне');
      expect(odd.code).toBeUndefined();
    });

    it('reads the officer and their role', () => {
      expect(parseSigner('Конюк Віталій Іванович - керівник')).toEqual({
        name: 'Конюк Віталій Іванович',
        role: 'керівник',
      });
      expect(parseSigner('Вільк Бартош Александер; (Згідно довіреності) - керівник').name).toBe(
        'Вільк Бартош Александер',
      );
    });

    it('reads the registration date in the register format, not ISO', () => {
      expect(parseRegistrationDate('21.10.2025; 21.10.2025; 4000702000000000002')).toBe(
        '2025-10-21T00:00:00.000Z',
      );
      expect(parseRegistrationDate('')).toBeUndefined();
    });
  });

  describe('what goes into the graph', () => {
    it('ingests the fixture without a single ontology rejection', () => {
      const result = connector.ingest(parseEdrBytes(bytes), 'edr-test');
      expect(result.subjectsRead).toBeGreaterThan(0);
      expect(result.organizationsIngested).toBeGreaterThan(0);
      expect(result.rejected).toEqual([]);
    });

    it('records declared ownership as declared, never as hidden', () => {
      // Wiring the register to HIDDEN_BENEFICIARY_OF would score disclosure as
      // concealment: 30 points for obeying the law, and an analyst told the
      // opposite of the truth.
      connector.ingest(parseEdrBytes(bytes), 'edr-test');
      const relations = new Set(graph.toJSON(insider).edges.map((e) => e.relation));
      expect(relations.has('BENEFICIARY_OF')).toBe(true);
      expect(relations.has('HIDDEN_BENEFICIARY_OF')).toBe(false);
    });

    it('records an absence declaration as a fact about the filing', () => {
      connector.ingest(parseEdrBytes(bytes), 'edr-test');
      const declaring = graph
        .toJSON(insider)
        .nodes.filter((n) => n.properties.beneficiary_absence_declared === true);
      expect(declaring.length).toBeGreaterThan(0);
      expect(String(declaring[0].properties.beneficiary_absence_reason)).not.toBe('');
    });

    it('notes a founder jurisdiction where the ownership chain stops', () => {
      connector.ingest(parseEdrBytes(bytes), 'edr-test');
      const opaque = graph.toJSON(insider).nodes.filter((n) => n.properties.founder_jurisdiction_opaque);
      expect(opaque.length).toBeGreaterThan(0);
      // A property, not a verdict: what it is worth is decided in the risk config.
      expect(String(opaque[0].properties.founder_jurisdiction)).toBeTruthy();
    });
  });

  describe('a name is not an identity', () => {
    it('keys a person to the company that named them', () => {
      connector.ingest(parseEdrBytes(bytes), 'edr-test');
      const people = graph.findByType('Person', insider);
      expect(people.length).toBeGreaterThan(0);
      for (const person of people) {
        expect(person.id).toMatch(/^person:edr:\d{8,10}:/);
        // Stated on the record rather than left to be assumed.
        expect(person.properties.identity_basis).toBe('name_as_filed_in_edr');
      }
    });

    it('proposes the same name in two companies rather than merging it', () => {
      // Two people called Іванов Іван Іванович are two people, and a graph
      // that keys them to one node has invented a relationship between two
      // real human beings who have none.
      connector.ingest(
        [
          {
            edrpou: '10000001',
            name: 'Перша компанія',
            founders: [],
            beneficiaries: ['Коваленко Іван Петрович; громадянство: Україна; відсоток частки - 50'],
            signers: [],
          },
          {
            edrpou: '10000002',
            name: 'Друга компанія',
            founders: [],
            beneficiaries: ['КОВАЛЕНКО ІВАН ПЕТРОВИЧ; громадянство: Україна; відсоток частки - 40'],
            signers: [],
          },
        ],
        'edr-two',
      );

      const people = graph.findByType('Person', insider);
      expect(people).toHaveLength(2);
      expect(people[0].id).not.toBe(people[1].id);

      // The link that matters is the one that needed a decision: the resolver
      // proposes it, `link_same_as` records who decided and on what basis.
      const proposed = resolveDuplicates(people, []).candidates;
      expect(proposed).toHaveLength(1);
      expect(proposed[0].confidence).toBeGreaterThanOrEqual(0.7);
    });
  });

  describe('personal data is not open data', () => {
    it('keeps named individuals behind a compartment by default', () => {
      connector.ingest(parseEdrBytes(bytes), 'edr-test');
      // The register is public, but a graph of named individuals with their
      // holdings is a different object from a map of substations.
      expect(graph.findByType('Person', outsider)).toHaveLength(0);
      expect(graph.findByType('Person', insider).length).toBeGreaterThan(0);

      const outside = graph.toJSON(outsider);
      expect(outside.nodes.length).toBeGreaterThan(0);
      expect(outside.edges.every((e) => e.relation === 'CONTROLS')).toBe(true);
      expect(JSON.stringify(outside)).not.toContain('громадянство');
    });

    it('keeps the searchable text behind the same marking as the people in it', () => {
      connector.ingest(parseEdrBytes(bytes), 'edr-test');
      const person = graph.findByType('Person', insider)[0];
      const surname = person.label.split(' ')[0];
      expect(vectors.search(surname, insider, 5).length).toBeGreaterThan(0);
      expect(vectors.search(surname, outsider, 5)).toHaveLength(0);
    });

    it('lets a deployment choose otherwise, explicitly', () => {
      connector.ingest(parseEdrBytes(bytes), 'edr-open', {
        personClearance: ClearanceLevel.PUBLIC,
        personCompartments: [],
      });
      expect(graph.findByType('Person', ClearanceLevel.PUBLIC).length).toBeGreaterThan(0);
    });
  });
});
