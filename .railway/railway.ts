/**
 * Railway deploy settings for the backend service.
 *
 * **The Railway dashboard is authoritative. This file is the record of what it
 * must contain.** Railway does not read `.railway/` during a deploy — it is
 * applied with the Railway CLI, which this project deliberately does not use
 * (the account carries other organisations' work, so service settings are
 * changed by hand in the dashboard instead). Nothing here reaches Railway on
 * its own.
 *
 * It is kept, rather than written as prose, for one reason: `npm run
 * typecheck:railway` compiles it against Railway's own published types, so the
 * record cannot drift into field names and enum values that do not exist. A
 * comment claiming the restart policy is `ON_FAILUER` would survive review;
 * this does not.
 *
 * It replaces the root `railway.json`, which Railway stops reading on
 * 1 December 2026. That file is not incidental: it carries the
 * `preDeployCommand` that runs `prisma migrate deploy` as a release step, and
 * the healthcheck that stops a deploy the app cannot serve from reporting
 * success. Both were absent from the first Railway service, and the result was
 * migrations that silently never ran behind deploys that all claimed to be
 * fine.
 *
 * Because the dashboard values and this file say the same thing, entering them
 * in the dashboard is a no-op while `railway.json` is still read, and becomes
 * the live configuration the moment it is not. There is no cutover window in
 * which migrations stop running.
 *
 * See docs/railway-service-settings.md for what to type where.
 */
import { defineRailway, project, service } from 'railway/iac';

/**
 * The service these settings belong to. Also scopes the file, should anyone
 * ever apply it: the project's Postgres and Redis are managed from the
 * dashboard and must stay outside it.
 */
export const partial = 'EduGear-BackEnd';

export default defineRailway(() => {
  const backend = service(partial, {
    build: {
      builder: 'DOCKERFILE',
      dockerfilePath: 'Dockerfile',
    },
    deploy: {
      startCommand: 'node dist/main',
      // An array here, where railway.json took a single string. Runs between
      // build and deploy, and a failure stops the deployment — which is what
      // we want: a deploy whose migrations did not apply must not go live.
      preDeployCommand: ['npx prisma migrate deploy'],
      // Ten minutes, which is far longer than any migration here has needed —
      // the current ones are additive and finish in seconds. The asymmetry is
      // the reason: Prisma wraps each migration in a transaction, so a kill
      // rolls the SQL back cleanly, but it leaves that migration marked
      // *failed* in `_prisma_migrations`, and every later deploy then refuses
      // to start until somebody runs `prisma migrate resolve` by hand against
      // production. Waiting ten minutes for a hung migration costs a delayed
      // deploy; cutting one short costs an outage that needs manual database
      // surgery. The case this headroom is really for is not today's
      // migrations but an index added to `students` or `payments` once a
      // school has a hundred thousand rows.
      preDeployTimeoutSeconds: 600,
      healthcheckPath: '/api/health',
      healthcheckTimeout: 60,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 3,
      numReplicas: 1,
    },
  });

  return project('appealing-charisma', { resources: [backend] });
});
