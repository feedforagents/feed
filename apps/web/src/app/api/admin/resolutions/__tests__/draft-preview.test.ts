import { afterEach, beforeEach, expect, it, mock } from 'bun:test';
import * as actualDb from '@feed/db';
import { NextRequest, NextResponse } from 'next/server';

let allowed = true;
let draft: { post: { articleTitle: string; content: string } } | null;
const readDraft = mock(() => {
  const query = {
    from: () => query,
    innerJoin: () => query,
    where: () => query,
    limit: async () => (draft ? [{ draft }] : []),
  };
  return query;
});

mock.module('@feed/db', () => ({
  ...actualDb,
  dbWrite: { select: readDraft },
}));

mock.module('@feed/api', () => ({
  errorResponse: (message: string, code: string, status: number) =>
    NextResponse.json({ error: { message, code } }, { status }),
  requireAdmin: async () => {
    if (!allowed) throw new Error('Admin access required');
    return { userId: 'admin-1' };
  },
  withErrorHandling: (handler: () => Promise<Response>) => handler,
}));

const { GET } = await import('../[id]/proof/route');

function getPreview() {
  return GET(
    new NextRequest('http://localhost/api/admin/resolutions/q1/proof'),
    { params: Promise.resolve({ id: 'q1' }) }
  );
}

const originalDeployment = process.env.DEPLOYMENT_ENV;

beforeEach(() => {
  process.env.DEPLOYMENT_ENV = 'localnet';
  allowed = true;
  draft = { post: { articleTitle: 'Proof', content: '<b>draft evidence</b>' } };
  readDraft.mockClear();
});

afterEach(() => {
  if (originalDeployment === undefined) delete process.env.DEPLOYMENT_ENV;
  else process.env.DEPLOYMENT_ENV = originalDeployment;
});

it('does not read the localnet work table in a hosted environment', async () => {
  process.env.DEPLOYMENT_ENV = 'staging';
  expect((await getPreview()).status).toBe(404);
  expect(readDraft).not.toHaveBeenCalled();
});

it('requires admin authorization before reading the draft', async () => {
  allowed = false;
  await expect(getPreview()).rejects.toThrow('Admin access required');
  expect(readDraft).not.toHaveBeenCalled();
});

it('returns the private draft as uncached plain text', async () => {
  const response = await getPreview();
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('content-type')).toBe(
    'text/plain; charset=utf-8'
  );
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(await response.text()).toBe('Proof\n\n<b>draft evidence</b>');
});

it('returns 404 when no current due draft matches', async () => {
  draft = null;
  expect((await getPreview()).status).toBe(404);
});
