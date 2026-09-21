-- CreateEnum
CREATE TYPE "FilePurpose" AS ENUM ('STUDENT_PHOTO', 'SCHOOL_LOGO', 'PAYMENT_EVIDENCE');

-- CreateTable
CREATE TABLE "file_objects" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "purpose" "FilePurpose" NOT NULL,
    "key" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "linkedType" TEXT,
    "linkedId" UUID,
    "uploadedByMembershipId" UUID,
    "uploadedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "file_objects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "file_objects_schoolId_purpose_idx" ON "file_objects"("schoolId", "purpose");

-- CreateIndex
CREATE INDEX "file_objects_schoolId_linkedType_linkedId_idx" ON "file_objects"("schoolId", "linkedType", "linkedId");

-- CreateIndex
CREATE INDEX "file_objects_schoolId_checksum_idx" ON "file_objects"("schoolId", "checksum");

-- CreateIndex
CREATE UNIQUE INDEX "file_objects_schoolId_key_key" ON "file_objects"("schoolId", "key");

-- AddForeignKey
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
