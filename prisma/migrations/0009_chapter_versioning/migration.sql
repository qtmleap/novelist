-- AlterTable
ALTER TABLE "Chapter" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- DropIndex
DROP INDEX "Chapter_novel_id_chapter_number_key";
DROP INDEX "Chapter_novel_id_idx";

-- CreateIndex
CREATE UNIQUE INDEX "Chapter_novel_id_chapter_number_version_key" ON "Chapter"("novel_id", "chapter_number", "version");
CREATE INDEX "Chapter_novel_id_chapter_number_idx" ON "Chapter"("novel_id", "chapter_number");
