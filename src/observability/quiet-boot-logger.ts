import { LoggerService } from '@nestjs/common';

/**
 * Nest narrates its own start-up: one line per mapped route, per resolved
 * module, per controller. On this application that is 236 lines in under a
 * second, against 5 that say anything — whether Postgres connected, whether
 * Redis is up, whether the permission catalogue synced.
 *
 * Railway rate-limits log output per deployment and **drops** what overflows.
 * So the cost is not noise, it is that a crash during boot gets discarded along
 * with the chatter, and the deployment looks like it stopped for no reason.
 *
 * Errors and warnings are never filtered. Only these three contexts, and only
 * where the volume is a liability — in development the full narration is
 * genuinely useful when a route does not appear where you expected.
 */
const BOOTSTRAP_NARRATION = new Set([
  'RouterExplorer',
  'RoutesResolver',
  'InstanceLoader',
]);

export class QuietBootLogger implements LoggerService {
  constructor(private readonly inner: LoggerService) {}

  /** Nest passes the context as the last argument of its logger calls. */
  private isNarration(params: unknown[]): boolean {
    const context = params[params.length - 1];
    return typeof context === 'string' && BOOTSTRAP_NARRATION.has(context);
  }

  log(message: unknown, ...params: unknown[]): void {
    if (this.isNarration(params)) return;
    this.inner.log(message, ...params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    if (this.isNarration(params)) return;
    this.inner.debug?.(message, ...params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    if (this.isNarration(params)) return;
    this.inner.verbose?.(message, ...params);
  }

  // Never filtered: the whole point is that these survive the boot burst.
  error(message: unknown, ...params: unknown[]): void {
    this.inner.error(message, ...params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.inner.warn(message, ...params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    (this.inner.fatal ?? this.inner.error).call(this.inner, message, ...params);
  }
}
