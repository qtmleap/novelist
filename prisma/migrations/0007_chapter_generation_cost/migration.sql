-- CreateTable
CREATE TABLE "ChapterGenerationCost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "novel_id" TEXT NOT NULL,
    "chapter_number" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "prompt_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "cost_usd" REAL NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChapterGenerationCost_novel_id_fkey" FOREIGN KEY ("novel_id") REFERENCES "Novel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ChapterGenerationCost_novel_id_idx" ON "ChapterGenerationCost"("novel_id");

