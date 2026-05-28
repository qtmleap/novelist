-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Novel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "genre" TEXT NOT NULL,
    "characters" TEXT NOT NULL,
    "setting" TEXT NOT NULL,
    "num_chapters" INTEGER NOT NULL,
    "target_chars" INTEGER NOT NULL DEFAULT 4000,
    "outline" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);
INSERT INTO "new_Novel" ("characters", "created_at", "genre", "id", "num_chapters", "outline", "setting", "title", "updated_at") SELECT "characters", "created_at", "genre", "id", "num_chapters", "outline", "setting", "title", "updated_at" FROM "Novel";
DROP TABLE "Novel";
ALTER TABLE "new_Novel" RENAME TO "Novel";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

