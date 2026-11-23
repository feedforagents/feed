import { scheduledInferenceFetch } from '@feed/db';
import { getSurplusConfig } from '@feed/shared';
import { z } from 'zod';

export function parseSurplusImageSource(body: unknown): string {
  const result = z
    .object({
      data: z.array(z.object({ url: z.string().max(28_000_000) })).min(1),
    })
    .parse(body);
  const source = result.data[0]!.url;
  // Some sellers return an inline image even when response_format is url.
  if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(source))
    return source;
  const url = new URL(source);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('Image provider returned an unsupported image source');
  return source;
}

let storeImage: ((url: string) => Promise<string>) | undefined;
export function setGeneratedImageStorage(
  store: (url: string) => Promise<string>
): void {
  storeImage = store;
}

export async function generateSurplusImage(options: {
  prompt: string;
  reference?: string | null;
  landscape?: boolean;
  persist?: boolean;
}): Promise<string> {
  const config = getSurplusConfig();
  if (!config) throw new Error('SURPLUS_API_KEY is required');
  const model = options.reference
    ? process.env.SURPLUS_IMAGE_EDIT_MODEL || 'nano-banana-2-edit'
    : process.env.SURPLUS_IMAGE_MODEL || 'venice-z-image-turbo';
  const response = await scheduledInferenceFetch(
    `${config.baseURL}/images/${options.reference ? 'edits' : 'generations'}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        prompt: options.prompt,
        n: 1,
        size: options.landscape ? '1536x1024' : '1024x1024',
        response_format: 'url',
        ...(options.reference ? { image: options.reference } : {}),
      }),
      signal: AbortSignal.timeout(120_000),
    }
  );
  if (!response.ok)
    throw new Error(`Image generation returned HTTP ${response.status}`);
  const url = parseSurplusImageSource(await response.json());
  if (!options.persist) return url;
  if (!storeImage)
    throw new Error('Generated image storage has not been configured');
  return storeImage(url);
}
