-- CreateEnum
CREATE TYPE "consent_methods" AS ENUM ('ADMISSION_FORM', 'CONSENT_FORM', 'PORTAL');

-- AlterTable
ALTER TABLE "students" ADD COLUMN     "sensitiveConsentAt" TIMESTAMP(3),
ADD COLUMN     "sensitiveConsentBy" VARCHAR(120),
ADD COLUMN     "sensitiveConsentMethod" "consent_methods",
ADD COLUMN     "sensitiveConsentWithdrawnAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "students_schoolId_sensitiveConsentAt_idx" ON "students"("schoolId", "sensitiveConsentAt");
