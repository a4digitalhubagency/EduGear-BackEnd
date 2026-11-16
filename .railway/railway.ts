/**
 * Railway configuration as code.
 *
 * Replaces the root `railway.json`, which Railway stops reading on 1 December
 * 2026. Every value below is a direct translation of that file — nothing is
 * new, and nothing was dropped.
 *
 * Two differences from the file it replaces are worth knowing:
 *
 * 1. Railway does not read this file during a deploy. The old `railway.json`
 *    was applied by pushing a commit; this is applied by running
 *    `railway apply`, which writes the settings onto the service. A change
 *    here does nothing until someone applies it.
 *
 * 2. `partial` scopes the file to one service. The project also holds Postgres
 *    and Redis, which are managed from the dashboard; without this, applying a
 *    file that describes only the backend invites Railway to reconcile the
 *    others against a definition that does not mention them.
 *
 * The settings themselves matter more than they look. `preDeployCommand` is
 * the release step that runs migrations — it is the reason this file cannot
 * simply be deleted — and `healthcheckPath` is what stops a deploy the app
 * cannot serve from being reported as a success. Both were missing from the
 * first Railway service, and the result was migrations that silently never ran
 * behind deploys that all claimed to be fine.
 */
import { defineRailway, project, service } from 'railway/iac';

/**
 * The one service this file manages. Must match the service's name in Railway
 * exactly; a name that matches nothing creates a second service rather than
 * updating this one.
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
      healthcheckPath: '/api/health',
      healthcheckTimeout: 60,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 3,
      numReplicas: 1,
    },
  });

  return project('appealing-charisma', { resources: [backend] });
});
