import type { ErrorEvent } from '@sentry/node';
import { scrub } from './sentry';

/**
 * The promise made to a school is that debugging their problem does not involve
 * shipping their data to a third party. `scrub` is where that promise lives, so
 * these tests are about what must *not* come out the other side.
 */
describe('Sentry event scrubbing', () => {
  /** An event with every field the SDK might realistically attach. */
  const event = (): ErrorEvent =>
    ({
      event_id: 'abc',
      server_name: 'edugear-web-7f4c9',
      request: {
        url: 'https://api.edugear.app/api/students?search=Adaeze%20Okafor',
        method: 'GET',
        headers: {
          authorization: 'Bearer eyJhbGciOi...',
          cookie: 'session=abc123',
        },
        cookies: { session: 'abc123' },
        data: { password: 'StrongPass123', amount: 50000 },
        query_string: 'search=Adaeze%20Okafor',
      },
      user: {
        id: '4f0c1f7a-1111-4000-8000-000000000001',
        email: 'principal@school.test',
        ip_address: '102.89.34.7',
        username: 'principal',
      },
      contexts: {
        trace: { trace_id: 't1', span_id: 's1' },
        runtime: { name: 'node', version: '22.0.0' },
        os: { name: 'linux' },
      },
    }) as unknown as ErrorEvent;

  it('keeps the path and drops the query string with it', () => {
    const scrubbed = scrub(event());

    expect(scrubbed?.request?.url).toBe('https://api.edugear.app/api/students');
    expect(scrubbed?.request?.method).toBe('GET');
    // A search term is a parent's or a child's name.
    expect(JSON.stringify(scrubbed)).not.toContain('Adaeze');
  });

  it('sends no headers, cookies or request body', () => {
    const scrubbed = scrub(event());

    expect(scrubbed?.request?.headers).toBeUndefined();
    expect(scrubbed?.request?.cookies).toBeUndefined();
    expect(scrubbed?.request?.data).toBeUndefined();
    expect(scrubbed?.request?.query_string).toBeUndefined();

    const serialised = JSON.stringify(scrubbed);
    for (const secret of [
      'Bearer',
      'eyJhbGciOi',
      'session=abc123',
      'StrongPass123',
    ]) {
      expect(serialised).not.toContain(secret);
    }
  });

  it('keeps a user id but no email, IP or username', () => {
    const scrubbed = scrub(event());

    // The id is what ties an error to a request in our own logs.
    expect(scrubbed?.user).toEqual({
      id: '4f0c1f7a-1111-4000-8000-000000000001',
    });
    const serialised = JSON.stringify(scrubbed);
    expect(serialised).not.toContain('principal@school.test');
    expect(serialised).not.toContain('102.89.34.7');
  });

  it('drops the hostname and every context but trace and runtime', () => {
    const scrubbed = scrub(event());

    expect(scrubbed?.server_name).toBeUndefined();
    expect(scrubbed?.contexts?.trace).toBeDefined();
    expect(scrubbed?.contexts?.runtime).toBeDefined();
    expect(scrubbed?.contexts?.os).toBeUndefined();
  });

  it('is a whitelist, so a field nobody anticipated is not passed through', () => {
    // The point of the shape being rebuilt rather than edited: whatever a future
    // integration starts attaching to `request` does not reach Sentry until
    // somebody adds it here on purpose.
    const withNewField = event();
    (withNewField.request as Record<string, unknown>).env = {
      DATABASE_URL: 'postgresql://user:password@host/db',
    };

    expect(JSON.stringify(scrub(withNewField))).not.toContain('postgresql://');
  });

  it('survives an event with nothing attached', () => {
    expect(() => scrub({ event_id: 'x' } as ErrorEvent)).not.toThrow();
    const bare = scrub({ event_id: 'x' } as ErrorEvent);
    expect(bare?.event_id).toBe('x');
  });
});
