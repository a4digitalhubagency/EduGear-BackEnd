-- AlterTable
ALTER TABLE "students" ADD COLUMN     "departedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "students_departedAt_idx" ON "students"("departedAt");
