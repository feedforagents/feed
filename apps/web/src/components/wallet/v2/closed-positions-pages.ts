/**
 * Collect every row of a paginated user-positions section.
 *
 * The positions endpoint pages its closed view (`page`/`limit`) and
 * reports `total`/`hasMore` for the section. Fetching only the first
 * page silently truncates the history at one page of rows, so page
 * through until the section is exhausted. A failed page stops the
 * walk and returns what was collected so far (an empty list when the
 * first page failed), matching the previous single-page behavior on
 * errors.
 */

export interface PositionsSectionPage<T> {
  positions: T[];
  total: number;
  hasMore: boolean;
}

/** Safety stop: 200 pages at the caller's page size is far past any real history. */
const MAX_POSITIONS_PAGES = 200;

export async function fetchAllPositionsPages<T>(
  fetchPage: (page: number) => Promise<PositionsSectionPage<T> | null>
): Promise<T[]> {
  const collected: T[] = [];
  for (let page = 1; page <= MAX_POSITIONS_PAGES; page++) {
    const result = await fetchPage(page);
    if (!result || result.positions.length === 0) break;
    collected.push(...result.positions);
    if (!result.hasMore || collected.length >= result.total) break;
  }
  return collected;
}
