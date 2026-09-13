-- CreateEnum
CREATE TYPE "ReminderStatus" AS ENUM ('SENT', 'FAILED');

-- CreateTable
CREATE TABLE "fee_reminders" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "guardianId" UUID,
    "email" TEXT NOT NULL,
    "amountOwed" DECIMAL(12,2) NOT NULL,
    "status" "ReminderStatus" NOT NULL,
    "sentByMembershipId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fee_reminders_schoolId_studentId_createdAt_idx" ON "fee_reminders"("schoolId", "studentId", "createdAt");

-- CreateIndex
CREATE INDEX "fee_reminders_schoolId_batchId_idx" ON "fee_reminders"("schoolId", "batchId");

-- CreateIndex
CREATE INDEX "fee_reminders_schoolId_createdAt_idx" ON "fee_reminders"("schoolId", "createdAt");

-- AddForeignKey
ALTER TABLE "fee_reminders" ADD CONSTRAINT "fee_reminders_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_reminders" ADD CONSTRAINT "fee_reminders_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_reminders" ADD CONSTRAINT "fee_reminders_guardianId_fkey" FOREIGN KEY ("guardianId") REFERENCES "guardians"("id") ON DELETE SET NULL ON UPDATE CASCADE;
