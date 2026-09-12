import * as fs from 'fs';
import * as path from 'path';
import { OntologyManifest } from '../../graph/OntologyManifest';
import { AuditLog } from '../../audit/AuditLog';
import { ClearanceLevel, clearanceAtLeast } from '../../security/Clearance';
import { Principal } from '../../security/ApiKeyAuth';
import { ManifestError, SourceManifest, parseSourceManifest } from './SourceManifest';
import { FetchPolicy } from './SourceFetcher';
import { INFRA_DISABLED_REASON } from '../InfraLayers';

/**
 * The feeds this deployment knows how to ingest.
 *
 * Manifests ship in `config/sources/` and can be added at runtime by somebody
 * cleared to do so. Registering is a privileged act and not because the data
 * is sensitive: a manifest decides what a feed writes into the graph and under
 * what marking, so adding one is closer to granting a right than to loading a
 * file.
 *
 * A manifest is validated against the ontology **here**, when it is
 * registered. That is the difference between a mapping error surfacing in
 * front of its author and surfacing per-row at three in the morning, where it
 * looks like bad source data and leaves the feed half-connected with nobody
 * noticing.
 */
export class SourceRegistry {
  private readonly manifests = new Map<string, SourceManifest>();

  constructor(
    private readonly ontology: OntologyManifest | undefined,
    private readonly audit: AuditLog,
    /**
     * Checked here so a feed that names an unreachable host fails in front of
     * its author, next to the ontology check and for the same reason.
     */
    private readonly fetchPolicy?: FetchPolicy,
    /**
     * Чи віддавати зараз фіди, що несуть обʼєкти критичної інфраструктури.
     *
     * Предикат, а не значення: перемикач крутять на ходу, і реєстр, який
     * запамʼятав відповідь при старті, вимагав би рестарту на кожен оберт
     * ручки. Усталене — «ні».
     */
    private readonly infraAllowed: () => boolean = () => false,
  ) {}

  /** Чи прихований цей маніфест поточним станом вимикача. */
  private hidden(manifest: SourceManifest): boolean {
    return manifest.criticalInfrastructure === true && !this.infraAllowed();
  }

  /** Rejects a manifest whose `fetch` names a host this deployment will not call. */
  private checkFetchHost(manifest: SourceManifest): void {
    if (!manifest.fetch || !this.fetchPolicy) return;
    const host = new URL(manifest.fetch.url).hostname.toLowerCase();
    if (!this.fetchPolicy.allowedHosts.includes(host)) {
      throw new ManifestError(
        `fetch.url names "${host}", which is not in this deployment's outbound allowlist ` +
          `(config/security_policies.json → outbound_fetch.allowed_hosts)`,
      );
    }
  }

  /**
   * Loads every manifest in a directory.
   *
   * One bad manifest does not stop the others: a deployment that refuses to
   * start because a feed nobody uses has a typo is a deployment that gets its
   * validation removed. The failures are returned so they can be reported.
   */
  loadDirectory(dir: string): { loaded: string[]; failed: { file: string; reason: string }[] } {
    const loaded: string[] = [];
    const failed: { file: string; reason: string }[] = [];
    if (!fs.existsSync(dir)) return { loaded, failed };

    for (const file of fs.readdirSync(dir).sort()) {
      if (!file.endsWith('.json')) continue;
      try {
        const manifest = parseSourceManifest(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')), this.ontology);
        this.checkFetchHost(manifest);
        this.manifests.set(manifest.id, manifest);
        loaded.push(manifest.id);
      } catch (err) {
        failed.push({ file, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return { loaded, failed };
  }

  /**
   * Фіди, доступні зараз.
   *
   * Ті, що несуть критичну інфраструктуру, зникають зі списку разом із правом
   * у них писати — і зникають *тут*, а не при завантаженні, щоб обертання
   * ручки не вимагало рестарту.
   */
  list(): SourceManifest[] {
    return Array.from(this.manifests.values())
      .filter((manifest) => !this.hidden(manifest))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Прихований фід не знаходиться: маршрут прийому відповість 404, як і має. */
  get(id: string): SourceManifest | undefined {
    const manifest = this.manifests.get(id);
    if (!manifest || this.hidden(manifest)) return undefined;
    return manifest;
  }

  /**
   * Усі маніфести, разом із прихованими.
   *
   * Потрібно рівно там, де прихованість не має значення або навіть шкодить:
   * прибирання вже записаного мусить знати імена фідів, які саме зараз
   * вимкнені, — інакше вимикач ховав би від чистки те, що сам і закрив.
   */
  all(): SourceManifest[] {
    return Array.from(this.manifests.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Скільки фідів зараз приховано вимикачем — для маршруту здоровʼя. */
  hiddenCount(): number {
    return Array.from(this.manifests.values()).filter((m) => this.hidden(m)).length;
  }

  /**
   * Adds or replaces a manifest.
   *
   * Replaces by id rather than appending, and records the previous version in
   * the audit entry. A feed's mapping is the thing that decides what its data
   * means, so changing one is a change to every fact it will write from then
   * on - and to the interpretation of everything it wrote before.
   */
  register(raw: unknown, principal: Principal): { manifest: SourceManifest; replaced: SourceManifest | undefined } {
    if (!clearanceAtLeast(principal.clearance, ClearanceLevel.CONFIDENTIAL)) {
      throw new ManifestError('registering a source requires CONFIDENTIAL clearance');
    }

    const manifest = parseSourceManifest(raw, this.ontology);
    this.checkFetchHost(manifest);
    // Зареєструвати фід інфраструктури, поки вимикач закритий, не можна: інакше
    // він мовчки чекав би в реєстрі й поїхав би при першому ж оберті ручки, а
    // той, хто його додавав, вважав би, що додав нічого.
    if (this.hidden(manifest)) throw new ManifestError(INFRA_DISABLED_REASON);

    const beyond = manifest.compartments.filter((c) => !principal.compartments.includes(c));
    if (beyond.length > 0) {
      // Same rule as every other write: a feed cannot be marked into a circle
      // its author is outside, or they would be publishing into a place they
      // can never read back to check.
      throw new ManifestError(`you are not read into: ${beyond.join(', ')}`);
    }
    if (manifest.defaultClearance > principal.clearance) {
      throw new ManifestError('a source cannot be classified above the person registering it');
    }

    const replaced = this.manifests.get(manifest.id);
    this.manifests.set(manifest.id, manifest);

    this.audit.append(principal.id, replaced ? 'source_replaced' : 'source_registered', {
      source: manifest.id,
      version: manifest.version,
      previousVersion: replaced?.version ?? null,
      entities: manifest.entities.map((e) => `${e.name}:${e.type}`),
      edges: manifest.edges.map((e) => `${e.from}-[${e.relation}]->${e.to}`),
      clearance: manifest.defaultClearance,
      compartments: manifest.compartments,
      fetchesFrom: manifest.fetch ? new URL(manifest.fetch.url).host : null,
    });

    return { manifest, replaced };
  }
}
