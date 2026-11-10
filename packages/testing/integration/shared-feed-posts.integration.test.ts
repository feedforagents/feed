import { expect, test } from 'bun:test';
import { join } from 'node:path';

for (const scenario of ['write-policy', 'visibility-pagination']) {
  test(`shared REST/MCP post operation: ${scenario}`, async () => {
    const child = Bun.spawn(
      [
        'bun',
        join(import.meta.dir, 'helpers/shared-feed-posts-fixture.ts'),
        scenario,
      ],
      {
        cwd: join(import.meta.dir, '../../..'),
        env: { ...process.env, NODE_ENV: 'test' },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`${stdout}\n${stderr}`);
    expect(stdout).toContain(`"scenario":"${scenario}"`);
    expect(exitCode).toBe(0);
  }, 60_000);
}
