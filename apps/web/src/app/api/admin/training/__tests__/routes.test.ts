import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextResponse } from 'next/server';

const triggerTraining = mock(async () => ({ success: true }));
const requireAdmin = mock(async () => ({ userId: 'admin-1' }));
const getBenchmarkSummary = mock(async () => ({ totalBenchmarks: 1 }));

mock.module('@feed/training', () => ({
  automationPipeline: {
    triggerTraining,
    checkTrainingReadiness: async () => ({ ready: true }),
  },
  benchmarkService: {
    getBenchmarkSummary,
  },
}));

mock.module('@feed/api', () => ({
  getClientIp: () => null,
  logAdminModify: async () => undefined,
  logAdminView: async () => undefined,
  requireAdmin,
  successResponse: (data: object) => NextResponse.json(data),
  withErrorHandling: (handler: (req: Request) => Promise<Response>) => handler,
}));

const trigger = (await import('../trigger/route')).POST;
const benchmark = (await import('../benchmark/route')).GET;

function post(handler: typeof trigger, body: object) {
  return handler(
    new Request('http://localhost/api/admin/training/x', {
      method: 'POST',
      body: JSON.stringify(body),
    }) as never
  ) as Promise<Response>;
}

describe('admin training routes', () => {
  beforeEach(() => {
    triggerTraining.mockClear();
    requireAdmin.mockClear();
    requireAdmin.mockResolvedValue({ userId: 'admin-1' });
    getBenchmarkSummary.mockClear();
  });

  it('trigger rejects string force and unbounded batchSize', async () => {
    expect((await post(trigger, { force: 'false' })).status).toBe(400);
    expect((await post(trigger, { batchSize: 1e9 })).status).toBe(400);
    expect((await post(trigger, { batchSize: 1.5 })).status).toBe(400);
    expect(triggerTraining).not.toHaveBeenCalled();
  });

  it('trigger passes validated options through', async () => {
    const res = await post(trigger, { batchSize: 500 });
    expect(res.status).toBe(200);
    expect(triggerTraining).toHaveBeenCalledWith({
      force: false,
      batchSize: 500,
    });
  });

  it('benchmark summary requires admin and returns historical results', async () => {
    const request = new Request(
      'http://localhost/api/admin/training/benchmark'
    );
    const response = await benchmark(request as never);
    expect(requireAdmin).toHaveBeenCalledWith(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      summary: { totalBenchmarks: 1 },
    });
  });

  it('does not read benchmark history when admin authorization fails', async () => {
    requireAdmin.mockRejectedValueOnce(new Error('Admin access required'));
    await expect(
      benchmark(
        new Request('http://localhost/api/admin/training/benchmark') as never
      )
    ).rejects.toThrow('Admin access required');
    expect(getBenchmarkSummary).not.toHaveBeenCalled();
  });
});
