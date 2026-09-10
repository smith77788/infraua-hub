import * as fs from 'fs';
import { NodeType } from './types';

export interface EntityTypeSpec {
  properties: string[];
  default_clearance: string;
}

export interface EdgeTypeSpec {
  from: NodeType | NodeType[];
  to: NodeType | NodeType[];
}

export interface OntologyManifestData {
  entity_types: Record<string, EntityTypeSpec>;
  edge_types: Record<string, EdgeTypeSpec>;
}

export interface EdgeValidation {
  valid: boolean;
  reason?: string;
}

function toArray<T>(v: T | T[]): T[] {
  return Array.isArray(v) ? v : [v];
}

/**
 * Config-driven ontology: which relation names exist and which node
 * types they may connect. Loaded from config/ontology.json rather than
 * hardcoded in TypeScript, so adding a new relation (or widening an
 * existing one to a new entity type) is a config change, not a code
 * change - the idea behind the "dynamic ontology" ambition in the
 * uploaded Nexus/Palantir-2.0 design docs, minus the part where an LLM
 * invents new node *types* at runtime with no validation at all.
 *
 * Node types themselves stay the fixed 5-entity set
 * (docs/analyst-architecture.md "Ontology") - only edges are
 * config-extensible, so a typo'd or hallucinated relation name is
 * rejected instead of being silently added to the graph.
 */
export class OntologyManifest {
  constructor(private readonly data: OntologyManifestData) {}

  static fromFile(path: string): OntologyManifest {
    return new OntologyManifest(JSON.parse(fs.readFileSync(path, 'utf-8')));
  }

  isKnownEntityType(type: string): boolean {
    return type in this.data.entity_types;
  }

  defaultClearanceFor(type: string): string | undefined {
    return this.data.entity_types[type]?.default_clearance;
  }

  validateEdge(relation: string, fromType: NodeType, toType: NodeType): EdgeValidation {
    const spec = this.data.edge_types[relation];
    if (!spec) {
      return { valid: false, reason: `Relation "${relation}" is not declared in the ontology manifest.` };
    }
    const allowedFrom = toArray(spec.from);
    const allowedTo = toArray(spec.to);
    if (!allowedFrom.includes(fromType)) {
      return { valid: false, reason: `Relation "${relation}" does not permit a source of type ${fromType} (allowed: ${allowedFrom.join(', ')}).` };
    }
    if (!allowedTo.includes(toType)) {
      return { valid: false, reason: `Relation "${relation}" does not permit a target of type ${toType} (allowed: ${allowedTo.join(', ')}).` };
    }
    return { valid: true };
  }
}
