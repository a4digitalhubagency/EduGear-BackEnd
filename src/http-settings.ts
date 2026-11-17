import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * JSON body ceiling. Express defaults to 100 KB, which a 500-row student import
 * with guardian columns overruns; 2 MB leaves headroom without inviting abuse.
 */
export const JSON_BODY_LIMIT = '2mb';

/**
 * How many proxies sit in front of this app, for `req.ip`.
 *
 * Railway rewrites X-Forwarded-For to `<real client>, <railway edge>` — it
 * strips whatever the caller sent and appends its own hop — so the client is
 * the second entry from the right, not the first. This was 1, which made
 * `req.ip` the edge address instead of the client's.
 *
 * That was not a cosmetic difference. Railway answers from several edge PoPs
 * and rotates between them mid-session, so every rate-limit bucket was keyed on
 * whichever PoP happened to take the request: one client spread across four
 * addresses got four budgets and never reached a limit, while unrelated people
 * behind one PoP shared a bucket and could throttle each other. Every
 * `SessionMeta.ip` written to a login record or an audit row was the edge's
 * address too.
 *
 * With fewer forwarded entries than this (a direct call, or a test) Express
 * falls back to the leftmost address it has, so local development and the
 * integration suite are unaffected.
 *
 * **Adding another proxy in front — a CDN, a WAF — adds a hop and this must go
 * up with it.** `rate-limit.e2e-spec.ts` is what fails if it does not.
 */
export const TRUSTED_PROXY_HOPS = 2;

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
  app.set('trust proxy', TRUSTED_PROXY_HOPS);
}
