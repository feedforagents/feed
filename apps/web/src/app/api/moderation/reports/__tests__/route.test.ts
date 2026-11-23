import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { NextRequest } from 'next/server';
import {
  CreateReportSchema,
  GetReportsSchema,
} from '../../../../../../../../packages/shared/src/validation/schemas/moderation';

const mockAuthenticate = mock();
const mockEvaluateReport = mock();
const mockStoreEvaluation = mock(async () => undefined);
const mockUserUpdate = mock(async () => ({}));
const mockReportUpdate = mock(async () => ({}));

class TestError extends Error {}

mock.module('@feed/api', () => ({
  authenticate: mockAuthenticate,
  BusinessLogicError: TestError,
  NotFoundError: TestError,
  evaluateReport: mockEvaluateReport,
  storeEvaluationResult: mockStoreEvaluation,
  successResponse: (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status }),
  withErrorHandling: (handler: (...args: unknown[]) => unknown) => handler,
}));

// The route runs duplicate detection and the insert inside db.$transaction
// with a pg_advisory_xact_lock first statement, so the mock transaction
// mirrors that shape: execute() swallows the lock, report.findFirst reports
// no recent duplicate, and report.create returns the payload.
const mockTx = {
  execute: async () => [],
  report: {
    findFirst: async () => null,
    create: async (args: { data: Record<string, unknown> }) => args.data,
  },
};

mock.module('@feed/db', () => ({
  sql: (strings: TemplateStringsArray) => strings.join(''),
  db: {
    user: {
      findUnique: async () => ({ id: 'target-1', isActor: false }),
      update: mockUserUpdate,
    },
    report: {
      findFirst: async () => null,
      create: async (args: { data: Record<string, unknown> }) => args.data,
      update: mockReportUpdate,
    },
    $transaction: async (callback: (tx: typeof mockTx) => unknown) =>
      callback(mockTx),
  },
}));

mock.module('@feed/shared', () => ({
  CreateReportSchema,
  GetReportsSchema,
  generateSnowflakeId: async () => 'report-1',
  logger: { info: mock(), warn: mock(), error: mock() },
}));

const { POST } = await import('../route');

function reportRequest(): NextRequest {
  return new Request('http://localhost/api/moderation/reports', {
    method: 'POST',
    body: JSON.stringify({
      reportType: 'user',
      reportedUserId: 'target-1',
      category: 'other',
      reason: 'This user keeps asking for money',
    }),
  }) as unknown as NextRequest;
}

describe('POST /api/moderation/reports auto-ban', () => {
  beforeEach(() => {
    mockAuthenticate.mockResolvedValue({ userId: 'reporter-1' });
    mockEvaluateReport.mockReset();
    mockUserUpdate.mockClear();
    mockReportUpdate.mockClear();
  });

  it('does not ban when reasoning merely mentions scam/CSAM', async () => {
    mockEvaluateReport.mockResolvedValue({
      outcome: 'valid_report',
      confidence: 0.95,
      reasoning: 'There is no evidence of a scam and no CSAM was found.',
      recommendedActions: ['warn_user'],
    });

    const response = (await POST(reportRequest())) as Response;

    expect(response.status).toBe(200);
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it('bans only on an explicit recommended action, with system provenance', async () => {
    mockEvaluateReport.mockResolvedValue({
      outcome: 'valid_report',
      confidence: 0.9,
      reasoning: 'Repeated fake investment solicitations.',
      recommendedActions: ['mark_scammer'],
    });

    await POST(reportRequest());

    expect(mockUserUpdate).toHaveBeenCalledTimes(1);
    const [args] = mockUserUpdate.mock.calls[0] as unknown as [
      { data: Record<string, unknown> },
    ];
    expect(args.data.isBanned).toBe(true);
    expect(args.data.isScammer).toBe(true);
    expect(args.data.isCSAM).toBe(false);
    expect(args.data.bannedBy).toBeNull();
  });

  it('ignores a non-array recommendedActions value', async () => {
    mockEvaluateReport.mockResolvedValue({
      outcome: 'valid_report',
      confidence: 0.9,
      reasoning: 'n/a',
      recommendedActions: 'do not ban_user',
    });

    await POST(reportRequest());

    expect(mockUserUpdate).not.toHaveBeenCalled();
  });
});
