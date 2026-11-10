import { OAuthError } from './contracts';

export async function readBoundedBody(request: Request): Promise<string> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new OAuthError('invalid_request', 408));
      void reader.cancel().catch(() => undefined);
    }, 5000);
  });
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16_384) {
        void reader.cancel().catch(() => undefined);
        throw new OAuthError('invalid_request');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    if (timer) clearTimeout(timer);
    reader.releaseLock();
  }
}
