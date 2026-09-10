import { checkGrounding } from '../../agents/analyst/narrative/GroundingValidator';
import { NarrativeInput } from '../../agents/analyst/narrative/NarrativeAdapter';
import { ClearanceLevel } from '../../core/security/Clearance';
import { describe, expect, it } from 'bun:test';

function baseInput(overrides: Partial<NarrativeInput> = {}): NarrativeInput {
  return {
    query: 'What is the total contract amount linked to John Doe?',
    hits: [
      {
        document: { id: 'doc-1', text: 'Director John Doe approved a contract.', source: 'Audit_Report.txt', sector: 'Corporate', clearance: ClearanceLevel.PUBLIC },
        score: 0.4,
      },
    ],
    subgraphNodeCount: 2,
    subgraph: {
      nodes: [
        { id: 'john_doe', type: 'Person', label: 'John Doe', properties: {}, clearance: ClearanceLevel.PUBLIC, source_doc_ids: [] },
        { id: 'shell_consulting_llc', type: 'Organization', label: 'Shell Consulting LLC', properties: {}, clearance: ClearanceLevel.PUBLIC, source_doc_ids: [] },
      ],
      edges: [
        { source: 'john_doe', target: 'shell_consulting_llc', relation: 'HIDDEN_BENEFICIARY_OF', properties: { amount: 1500000 }, clearance: ClearanceLevel.PUBLIC, source_doc_ids: [] },
      ],
    },
    computation: { description: 'summed 1 amount', result: { sum: 1500000, count: 1 } },
    ...overrides,
  };
}

describe('checkGrounding', () => {
  it('accepts a narrative that only restates known entities and numbers', () => {
    const narrative = 'John Doe is linked to Shell Consulting LLC via a hidden beneficiary relationship totaling $1,500,000.';
    expect(checkGrounding(narrative, baseInput())).toEqual({ grounded: true });
  });

  it('rejects a narrative that invents a monetary amount', () => {
    const narrative = 'John Doe is linked to a contract worth $9,999,999.';
    const result = checkGrounding(narrative, baseInput());
    expect(result.grounded).toBe(false);
    expect(result.reason).toMatch(/number/);
  });

  it('rejects a narrative that invents a named entity', () => {
    const narrative = 'John Doe is also connected to Acme Global Trading Partners.';
    const result = checkGrounding(narrative, baseInput());
    expect(result.grounded).toBe(false);
    expect(result.reason).toMatch(/entity/);
  });

  it('tolerates small structural numbers not present in the data', () => {
    const narrative = 'Found 2 related entities for John Doe and Shell Consulting LLC.';
    expect(checkGrounding(narrative, baseInput()).grounded).toBe(true);
  });
});
