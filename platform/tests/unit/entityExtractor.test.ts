import { EntityExtractor } from '../../core/ingestion/EntityExtractor';
import { describe, expect, it } from 'bun:test';

describe('EntityExtractor', () => {
  const extractor = new EntityExtractor();

  it('extracts a person, an organization, a beneficiary relation and an amount', () => {
    const result = extractor.extract(
      'Audit report: Director John Doe approved a no-bid contract worth $1,500,000 with Shell Consulting LLC, a hidden beneficiary vendor.'
    );

    const orgLabels = result.nodes.filter((n) => n.type === 'Organization').map((n) => n.label);
    const personLabels = result.nodes.filter((n) => n.type === 'Person').map((n) => n.label);

    expect(personLabels).toContain('John Doe');
    expect(orgLabels.some((l) => l.includes('Shell Consulting'))).toBe(true);

    const edge = result.edges.find((e) => e.relation === 'HIDDEN_BENEFICIARY_OF' || e.relation === 'AWARDED_CONTRACT');
    expect(edge).toBeDefined();
    expect(edge?.properties.amount).toBe(1500000);
  });

  it('extracts a supply disruption relation with a delay in days', () => {
    const result = extractor.extract(
      'Logistics alert: Component Vendor Corp reports a critical delay of 45 days affecting Main Factory Corp deliveries.'
    );
    const edge = result.edges.find((e) => e.relation === 'SUPPLY_DISRUPTION');
    expect(edge).toBeDefined();
    expect(edge?.properties.delay_days).toBe(45);
  });

  it('extracts geographic coordinates into a Location node', () => {
    const result = extractor.extract('The warehouse is located at 48.8584, 2.2945 per the latest survey.');
    const location = result.nodes.find((n) => n.type === 'Location');
    expect(location?.properties).toEqual({ lat: 48.8584, lon: 2.2945 });
  });

  it('anchors a coordinate to the named organization in the same sentence via LOCATED_AT', () => {
    const result = extractor.extract('Component Vendor Corp is located at 48.8584, 2.2945 per the survey.');
    const locatedEdge = result.edges.find((e) => e.relation === 'LOCATED_AT');
    expect(locatedEdge).toBeDefined();
    expect(locatedEdge?.sourceLabel).toContain('Component Vendor Corp');
    expect(locatedEdge?.targetLabel).toContain('48.8584');
  });

  it('extracts nothing from unstructured prose with no facts', () => {
    const result = extractor.extract('It was a calm afternoon and nothing of note occurred.');
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });
});
