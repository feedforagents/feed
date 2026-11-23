import { and, db, desc, lt, type SQL, sql } from '@feed/db';
import { logger } from '@feed/shared';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

const PAGE_SIZE = 128;

type ExportFields = Record<string, PgColumn> & { id: PgColumn };

export async function* exportRows(
  table: PgTable,
  fields: ExportFields,
  owner: SQL,
  createdAt?: PgColumn
): AsyncGenerator<string> {
  const idColumn = fields.id;
  const order = createdAt
    ? [desc(createdAt), desc(idColumn)]
    : [desc(idColumn)];

  let cursor: SQL | undefined;
  let separator = '';
  yield '[';
  for (;;) {
    const page = await db
      .select({
        ...fields,
        id: sql<string>`${idColumn}`,
        // Keep PostgreSQL's microsecond precision for the next page.
        cursorTime: createdAt ? sql<string>`${createdAt}::text` : sql`null`,
      })
      .from(table)
      .where(and(owner, cursor))
      .orderBy(...order)
      .limit(PAGE_SIZE);
    const last = page.at(-1);
    if (!last) break;

    const data = page.map(({ cursorTime: _cursorTime, ...row }) => row);
    yield separator + JSON.stringify(data).slice(1, -1);
    if (page.length < PAGE_SIZE) break;

    separator = ',';
    cursor = createdAt
      ? sql`${createdAt} <= ${last.cursorTime}::timestamp
          and (${createdAt}, ${idColumn}) < (${last.cursorTime}::timestamp, ${last.id})`
      : lt(idColumn, last.id);
  }
  yield ']';
}

export async function* exportObject(
  fields: Record<string, string | AsyncIterable<string>>
): AsyncGenerator<string> {
  let separator = '{';
  for (const [key, content] of Object.entries(fields)) {
    yield `${separator}${JSON.stringify(key)}:`;
    if (typeof content === 'string') {
      yield content;
    } else {
      yield* content;
    }
    separator = ',';
  }
  yield separator === '{' ? '{}' : '}';
}

export function streamExport(content: AsyncGenerator<string>) {
  const encoder = new TextEncoder();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await content.next();
        if (cancelled) return;
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        if (cancelled) return;
        logger.error('Account export interrupted', undefined, 'UserDataExport');
        controller.error(error);
      }
    },
    async cancel() {
      cancelled = true;
      await content.return(undefined);
    },
  });
}
