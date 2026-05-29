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
    "pov" TEXT NOT NULL DEFAULT '一人称',
    "tone" TEXT NOT NULL DEFAULT '一般文芸',
    "age_rating" TEXT NOT NULL DEFAULT '全年齢',
    "pov_character_id" TEXT NOT NULL DEFAULT '',
    "ending" TEXT NOT NULL DEFAULT '未指定',
    "notes" TEXT NOT NULL DEFAULT '',
    "editor_model" TEXT NOT NULL DEFAULT 'gemini-3.1-flash-lite',
    "writer_model" TEXT NOT NULL DEFAULT 'gemini-3.1-flash-lite',
    "outline" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);
INSERT INTO "new_Novel" ("age_rating", "characters", "created_at", "ending", "genre", "id", "notes", "num_chapters", "outline", "pov", "pov_character_id", "setting", "target_chars", "title", "tone", "updated_at") SELECT "age_rating", "characters", "created_at", "ending", "genre", "id", "notes", "num_chapters", "outline", "pov", "pov_character_id", "setting", "target_chars", "title", "tone", "updated_at" FROM "Novel";
DROP TABLE "Novel";
ALTER TABLE "new_Novel" RENAME TO "Novel";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
