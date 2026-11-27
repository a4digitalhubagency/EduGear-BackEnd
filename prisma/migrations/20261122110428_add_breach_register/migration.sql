-- CreateEnum
CREATE TYPE "BreachStatus" AS ENUM ('OPEN', 'CONTAINED', 'CLOSED');

-- CreateTable
CREATE TABLE "breach_records" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "discoveredAt" TIMESTAMP(3) NOT NULL,
    "occurredFrom" TIMESTAMP(3),
    "occurredTo" TIMESTAMP(3),
    "description" TEXT NOT NULL,
    "dataCategories" TEXT[],
    "riskAssessment" TEXT NOT NULL,
    "highRisk" BOOLEAN NOT NULL DEFAULT false,
    "affectedSubjects" INTEGER,
    "affectedSchoolIds" UUID[],
    "containment" TEXT,
    "subjectNotification" TEXT,
    "subjectsNotifiedAt" TIMESTAMP(3),
    "commissionNotifiedAt" TIMESTAMP(3),
    "notificationNotRequiredReason" TEXT,
    "contactName" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "status" "BreachStatus" NOT NULL DEFAULT 'OPEN',
    "recordedByAdminId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "breach_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "breach_records_reference_key" ON "breach_records"("reference");

-- CreateIndex
CREATE INDEX "breach_records_status_discoveredAt_idx" ON "breach_records"("status", "discoveredAt");

-- CreateIndex
CREATE INDEX "breach_records_discoveredAt_idx" ON "breach_records"("discoveredAt");
