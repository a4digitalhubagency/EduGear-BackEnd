import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * JSON body ceiling. Express defaults to 100 KB, which a 500-row student import
 * with guardian columns overruns; 2 MB leaves headroom without inviting abuse.
 */
export const JSON_BODY_LIMIT = '2mb';

/**
 * HTTP settings shared by the real server and the test harness, so an
 * integration test exercises the same prefix, proxy handling and body limit
 * that production does rather than a hand-maintained copy of them.
 */
export function applyHttpSettings(
  app: NestExpressApplication,
  apiPrefix: string,
): void {
  app.setGlobalPrefix(apiPrefix);
  // Registered before init, so Nest skips its default 100 KB JSON parser.
  // The raw bytes are kept because a provider signature is computed over the
  // body exactly as sent — re-serialising the parsed object would not match.
  app.useBodyParser('json', {
    limit: JSON_BODY_LIMIT,
    verify: (
      request: IncomingMessage & { rawBody?: Buffer },
      _response: ServerResponse,
      buffer: Buffer,
    ) => {
      request.rawBody = Buffer.from(buffer);
    },
  });
  // Behind Railway/Fly/Cloud Run, the real client IP arrives in X-Forwarded-For.
  app.set('trust proxy', 1);
}
