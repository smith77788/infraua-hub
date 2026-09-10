import { ProzorroTender } from './ProzorroConnector';

/**
 * Reads pages from the Prozorro public API.
 *
 * The rest of this platform is push-only: the console fetches and posts. That
 * suits feeds the console already renders, and does not suit this one - nobody
 * is going to look at a procurement register on a map, and the data is only
 * useful once it is *in* the graph next to the infrastructure it paid for.
 *
 * So the platform pulls here, and does so under three deliberate limits:
 *
 * - **Only when asked.** No timer, no background loop. A scheduler needs a
 *   lock, and there is no lock across the Railway restarts this runs on; two
 *   instances sweeping the same window would double every amount in
 *   `value_concentration` without anything looking wrong.
 * - **A bounded number of pages per call**, so a caller cannot turn one
 *   request into an unbounded crawl of somebody else's public service.
 * - **A hard timeout per request**, because a feed that hangs must fail rather
 *   than hold the API's own request open behind it.
 *
 * The tender list endpoint returns only ids and modification times; the detail
 * of each tender is a second call. That is the API's shape, not a choice here.
 */

const DEFAULT_BASE = 'https://public.api.openprocurement.org/api/2.5';

export interface PullOptions {
  /** Pages of the change feed to walk. Each page is up to `pageSize` tenders. */
  maxPages?: number;
  pageSize?: number;
  /** Milliseconds per HTTP request. */
  timeoutMs?: number;
  /** Only return tenders modified at or after this ISO timestamp. */
  since?: string;
  /** Stop after this many tender details, however many pages remain. */
  maxTenders?: number;
}

export interface PullResult {
  tenders: ProzorroTender[];
  pagesRead: number;
  /** Ids the detail call failed on, with the reason. Never silently dropped. */
  failed: { id: string; reason: string }[];
  /** Cursor for the next call, so a later pull resumes instead of restarting. */
  nextOffset: string | null;
}

export class ProzorroClient {
  constructor(private readonly baseUrl: string = DEFAULT_BASE) {}

  private async getJson(url: string, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          // Identifying the caller is the courtesy an open API is owed, and
          // the thing that gets an anonymous client blocked when it is missing.
          'User-Agent': 'InfraUA-Platform/1.0 (critical infrastructure analysis; +https://github.com/smith77788/infraua-hub)',
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async pull(options: PullOptions = {}, offset?: string): Promise<PullResult> {
    const maxPages = Math.max(1, Math.min(20, options.maxPages ?? 1));
    const pageSize = Math.max(1, Math.min(100, options.pageSize ?? 50));
    const timeoutMs = Math.max(1000, Math.min(60_000, options.timeoutMs ?? 20_000));
    const maxTenders = Math.max(1, Math.min(1000, options.maxTenders ?? 200));

    const tenders: ProzorroTender[] = [];
    const failed: { id: string; reason: string }[] = [];
    let cursor = offset;
    let pagesRead = 0;

    for (let page = 0; page < maxPages && tenders.length < maxTenders; page++) {
      const url = new URL(`${this.baseUrl}/tenders`);
      url.searchParams.set('limit', String(pageSize));
      url.searchParams.set('descending', '1');
      if (cursor) url.searchParams.set('offset', cursor);

      const body = (await this.getJson(url.toString(), timeoutMs)) as {
        data?: { id: string; dateModified?: string }[];
        next_page?: { offset?: string };
      };
      pagesRead += 1;
      const rows = body.data ?? [];
      cursor = body.next_page?.offset;

      for (const row of rows) {
        if (tenders.length >= maxTenders) break;
        if (options.since && row.dateModified && row.dateModified < options.since) continue;
        try {
          const detail = (await this.getJson(`${this.baseUrl}/tenders/${row.id}`, timeoutMs)) as {
            data?: ProzorroTender;
          };
          if (detail.data) tenders.push(detail.data);
        } catch (err) {
          // One unreadable tender must not lose the page it came in. Recorded
          // so a caller can see the feed degrading rather than assume a quiet
          // day in procurement.
          failed.push({ id: row.id, reason: err instanceof Error ? err.message : String(err) });
        }
      }

      if (rows.length === 0 || !cursor) break;
    }

    return { tenders, pagesRead, failed, nextOffset: cursor ?? null };
  }
}
