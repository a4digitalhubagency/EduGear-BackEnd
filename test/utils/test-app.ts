import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { applyHttpSettings } from '../../src/http-settings';

export interface TestContext {
  app: INestApplication;
  /** Raw, UNGUARDED client. Tests use it to arrange and to verify leakage. */
  db: PrismaClient;
  http: () => ReturnType<typeof request>;
}

/**
 * Stand-ins for providers a test must not let reach the network — the payment
 * provider, above all. Everything else stays real.
 */
export interface TestAppOptions {
  overrides?: { provide: unknown; useValue: unknown }[];
}

export async function createTestApp(
  options: TestAppOptions = {},
): Promise<TestContext> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  for (const override of options.overrides ?? []) {
    builder = builder
      .overrideProvider(override.provide)
      .useValue(override.useValue);
  }
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>();
  // The same prefix, proxy handling and body limit as production.
  applyHttpSettings(app, 'api');
  await app.init();

  const db = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  });

  return {
    app,
    db,
    http: () => request(app.getHttpServer()),
  };
}

export async function closeTestApp(ctx: TestContext): Promise<void> {
  await ctx.db.$disconnect();
  await ctx.app.close();
}

/** Wipes every table. Order is irrelevant thanks to CASCADE. */
export async function resetDatabase(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE
      webhook_events,
      audit_logs,
      file_objects,
      notifications,
      attendance_records,
      subject_results,
      student_results,
      result_sheets,
      scores,
      teaching_assignments,
      class_subjects,
      subjects,
      assessment_components,
      grade_bands,
      fee_reminders,
      payments,
      student_fee_items,
      student_fees,
      fee_structure_items,
      fee_structures,
      fee_categories,
      student_guardians,
      students,
      guardians,
      class_arms,
      classes,
      terms,
      academic_sessions,
      verification_tokens,
      refresh_tokens,
      memberships,
      role_permissions,
      roles,
      schools,
      users
    RESTART IDENTITY CASCADE;
  `);
}

export interface RegisteredSchool {
  schoolId: string;
  schoolName: string;
  userId: string;
  membershipId: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

/** Registers a school through the public API — same path a real customer takes. */
export async function registerSchool(
  ctx: TestContext,
  overrides: Partial<{
    schoolName: string;
    email: string;
    password: string;
  }> = {},
): Promise<RegisteredSchool> {
  const unique = Math.random().toString(36).slice(2, 8);
  const schoolName = overrides.schoolName ?? `Test School ${unique}`;
  const email = overrides.email ?? `owner-${unique}@example.com`;
  const password = overrides.password ?? 'StrongPass123';

  const response = await ctx
    .http()
    .post('/api/auth/register-school')
    .send({
      schoolName,
      schoolEmail: `info-${unique}@example.com`,
      firstName: 'Test',
      lastName: 'Owner',
      email,
      password,
    })
    .expect(201);

  const body = response.body;
  return {
    schoolId: body.activeSchool.schoolId,
    schoolName,
    userId: body.user.id,
    membershipId: body.activeSchool.membershipId,
    email,
    password,
    accessToken: body.tokens.accessToken,
    refreshToken: body.tokens.refreshToken,
  };
}
