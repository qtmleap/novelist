-- CreateTable
CREATE TABLE "NovelGenerationJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "novel_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "pending" TEXT NOT NULL,
    "current" INTEGER,
    "model" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "NovelGenerationJob_novel_id_fkey" FOREIGN KEY ("novel_id") REFERENCES "Novel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "NovelGenerationJob_novel_id_key" ON "NovelGenerationJob"("novel_id");
