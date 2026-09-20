-- CreateTable
CREATE TABLE "school_settings" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "admissionNumberPrefix" TEXT,
    "receiptPrefix" TEXT NOT NULL DEFAULT 'RCP',
    "portalEnabled" BOOLEAN NOT NULL DEFAULT true,
    "reminderCooldownDays" INTEGER NOT NULL DEFAULT 7,
    "invoiceDueDays" INTEGER,
    "reportShowPosition" BOOLEAN NOT NULL DEFAULT true,
    "reportShowClassStats" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "school_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "school_settings_schoolId_key" ON "school_settings"("schoolId");

-- AddForeignKey
ALTER TABLE "school_settings" ADD CONSTRAINT "school_settings_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
