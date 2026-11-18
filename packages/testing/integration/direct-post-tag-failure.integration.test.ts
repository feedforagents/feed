/** PRD §§12–13 / MVP Phase 3: optional tagging cannot undo a committed post. */
import { afterAll, test } from 'bun:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

// A fresh process prevents other suites' cached tag-client configuration from
// masking these faults. Only the fixture child receives the loopback settings.
let mode = 'http-error';
let requests = 0;
let tagLabel = '';
const provider = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    assert.equal(new URL(request.url).pathname, '/v1/chat/completions');
    requests++;
    if (mode === 'http-error') {
      return Response.json(
        { error: { message: 'Injected local provider outage' } },
        { status: 503 }
      );
    }
    const content =
      mode === 'empty'
        ? ''
        : mode === 'malformed'
          ? 'not XML'
          : `<response><tags><tag><displayName>${tagLabel}</displayName><category>Tech</category></tag></tags></response>`;
    return Response.json({
      id: 'local-fixture',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
    });
  },
});
afterAll(() => provider.stop(true));
const scenarios = [
  [
    'http-error',
    'Cobalt satellites trace quiet orbital routes beyond Neptune.',
  ],
  ['empty', 'Saffron bakers measure fragrant pastry layers before sunrise.'],
  [
    'malformed',
    'Quartz musicians practice delicate violin harmonies beside rivers.',
  ],
  [
    'success',
    'Jade botanists catalogue resilient alpine flowers during spring.',
  ],
  ['invalid', 'no'],
] as const;
for (const [scenario, content] of scenarios) {
  test(`preserves real post result for ${scenario} tagging`, async () => {
    mode = scenario;
    requests = 0;
    tagLabel = `Acceptance ${crypto.randomUUID()}`;
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, 'helpers/direct-post-tag-failure.ts'),
        scenario,
        content,
        tagLabel,
      ],
      {
        env: {
          ...process.env,
          SURPLUS_API_KEY: '',
          ELIZACLOUD_API_KEY: '',
          OPENAI_API_KEY: '',
          ANTHROPIC_API_KEY: '',
          GROQ_API_KEY: 'not-a-real-key-loopback-fixture',
          GROQ_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
          GROQ_SMALL_MODEL: 'local-fault-fixture',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const timeout = setTimeout(() => child.kill(), 20000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      assert.equal(code, 0, `${stdout}\n${stderr}`);
      assert.equal(requests, scenario === 'invalid' ? 0 : 1);
    } finally {
      clearTimeout(timeout);
    }
  }, 30000);
}
