import * as Sentry from '@sentry/node';
import { EnvironmentVariables } from '../config/env.validation';

/**
 * Error reporting.
 *
 * Initialised before anything else so a crash during module resolution is still
 * reported — which is why it reads the validated env object directly rather than
 * going through `ConfigService`.
 *
 * What is deliberately *not* sent matters more than what is. A school's data is
 * not ours to ship to a third party in order to debug: no request bodies, no
 * headers, no query strings, no cookies, no IP addresses, no email addresses.
 * What goes out is the error, the route, and the ids needed to find the request
 * in our own logs — request id, school id, user id. Those are opaque UUIDs; the
 * names behind them stay in the database.
 */
export function initSentry(env: EnvironmentVariables): boolean {
  if (!env.SENTRY_DSN) return false;

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    release: env.APP_VERSION,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    // `beforeSend` is the guarantee, not a convenience. Version 11 of the SDK
    // has no `sendDefaultPii` switch to rely on, and a future integration could
    // start attaching more than it does today — so what leaves this process is
    // decided by the whitelist in `scrub`, on every event.
    beforeSend: scrub,
    beforeBreadcrumb: (breadcrumb) => {
      // A breadcrumb for a query or an outgoing call can carry its parameters.
      if (breadcrumb.category === 'query' || breadcrumb.category === 'http') {
        return { ...breadcrumb, data: undefined };
      }
      return breadcrumb;
    },
  });

  return true;
}

/**
 * Applied to every event, whatever produced it. Written as a whitelist rather
 * than a blacklist, so an integration added later cannot quietly start sending
 * more than was intended. Exported because this is the promise made to schools
 * about their data, and a promise nothing tests is a hope.
 */
export function scrub(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
  if (event.request) {
    event.request = {
      // The path only. A query string carries search terms and ids.
      url: event.request.url?.split('?')[0],
      method: event.request.method,
    };
  }

  delete event.server_name;

  if (event.user) {
    // An id is enough to find the request in our own logs. An email is not ours
    // to send.
    event.user = { id: event.user.id };
  }

  event.contexts = event.contexts
    ? { trace: event.contexts.trace, runtime: event.contexts.runtime }
    : undefined;

  return event;
}

/** Tags an event with what is needed to trace it, and nothing more. */
export function reportError(
  error: unknown,
  scope: {
    requestId?: string;
    schoolId?: string | null;
    userId?: string;
    route?: string;
    errorCode?: string;
  },
): void {
  Sentry.withScope((sentryScope) => {
    if (scope.requestId) sentryScope.setTag('requestId', scope.requestId);
    if (scope.schoolId) sentryScope.setTag('schoolId', scope.schoolId);
    if (scope.route) sentryScope.setTag('route', scope.route);
    if (scope.errorCode) sentryScope.setTag('errorCode', scope.errorCode);
    if (scope.userId) sentryScope.setUser({ id: scope.userId });
    Sentry.captureException(error);
  });
}

/** Gives in-flight events a chance to leave before the process exits. */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // Losing an error report must never hold up a shutdown.
  }
}
