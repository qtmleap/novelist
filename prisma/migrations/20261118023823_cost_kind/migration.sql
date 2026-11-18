-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ChapterGenerationCost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "novel_id" TEXT NOT NULL,
    "chapter_number" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "prompt_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "cost_usd" REAL NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'chapter',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChapterGenerationCost_novel_id_fkey" FOREIGN KEY ("novel_id") REFERENCES "Novel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ChapterGenerationCost" ("chapter_number", "cost_usd", "created_at", "id", "model", "novel_id", "output_tokens", "prompt_tokens") SELECT "chapter_number", "cost_usd", "created_at", "id", "model", "novel_id", "output_tokens", "prompt_tokens" FROM "ChapterGenerationCost";
DROP TABLE "ChapterGenerationCost";
ALTER TABLE "new_ChapterGenerationCost" RENAME TO "ChapterGenerationCost";
CREATE INDEX "ChapterGenerationCost_novel_id_idx" ON "ChapterGenerationCost"("novel_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

