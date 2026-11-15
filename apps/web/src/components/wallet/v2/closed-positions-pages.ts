/** Select closed history from the existing complete status=all/type=all view. */
type PositionRow = Record<string, unknown>;

function record(value: unknown): PositionRow {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid positions snapshot');
  return value as PositionRow;
}

function rowId(row: PositionRow): string {
  if (typeof row.id !== 'string' || row.id.length === 0)
    throw new Error('Invalid position ID');
  return row.id;
}

function completeSection(value: unknown): PositionRow[] {
  const section = record(value);
  if (
    !Array.isArray(section.positions) ||
    typeof section.total !== 'number' ||
    !Number.isSafeInteger(section.total) ||
    section.total !== section.positions.length ||
    section.hasMore !== false
  )
    throw new Error('Incomplete positions snapshot');
  const positions: unknown[] = section.positions;
  const rows = positions.map(record);
  if (new Set(rows.map(rowId)).size !== rows.length)
    throw new Error('Duplicate positions in snapshot');
  return rows;
}

function timestamp(value: unknown): number {
  if (value === null) return 0;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new Error('Invalid position timestamp');
  return Date.parse(value);
}

function sortClosed(rows: PositionRow[], time: (row: PositionRow) => number) {
  return rows.sort((left, right) => {
    const difference = time(right) - time(left);
    if (difference) return difference;
    const leftId = rowId(left),
      rightId = rowId(right);
    return leftId === rightId ? 0 : leftId < rightId ? 1 : -1;
  });
}

export async function fetchClosedPositionsSnapshot(
  fetchSnapshot: (signal?: AbortSignal) => Promise<unknown>,
  signal?: AbortSignal
): Promise<{ perpetuals: PositionRow[]; predictions: PositionRow[] }> {
  signal?.throwIfAborted();
  const payload = await fetchSnapshot(signal);
  signal?.throwIfAborted();
  const snapshot = record(payload);
  // Validate both complete sections before selecting or returning either one.
  const perps = completeSection(snapshot.perpetuals);
  const predictions = completeSection(snapshot.predictions);
  const closedPerps = perps.filter((row) => {
    timestamp(row.closedAt);
    return row.closedAt !== null;
  });
  const closedPredictions = predictions.filter((row) => {
    if (
      typeof row.status !== 'string' ||
      !['number', 'string'].includes(typeof row.shares) ||
      (typeof row.shares === 'string' && row.shares.trim() === '') ||
      !Number.isFinite(Number(row.shares))
    )
      throw new Error('Invalid prediction position');
    const closed = row.status === 'closed' || row.status === 'resolved';
    if (closed) timestamp(row.resolvedAt ?? row.createdAt ?? null);
    // Preserve the endpoint's existing zero-share exclusion.
    return closed && Number(row.shares) >= 0.01;
  });
  return {
    perpetuals: sortClosed(closedPerps, (row) => timestamp(row.closedAt)),
    predictions: sortClosed(closedPredictions, (row) =>
      timestamp(row.resolvedAt ?? row.createdAt ?? null)
    ),
  };
}
