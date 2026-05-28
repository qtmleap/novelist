-- CreateTable
CREATE TABLE "NovelCharacter" (
    "novel_id" TEXT NOT NULL,
    "character_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT '',

    PRIMARY KEY ("novel_id", "character_id"),
    CONSTRAINT "NovelCharacter_novel_id_fkey" FOREIGN KEY ("novel_id") REFERENCES "Novel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NovelCharacter_character_id_fkey" FOREIGN KEY ("character_id") REFERENCES "Character" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "NovelCharacterRelation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "novel_id" TEXT NOT NULL,
    "source_character_id" TEXT NOT NULL,
    "target_character_id" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "NovelCharacterRelation_novel_id_fkey" FOREIGN KEY ("novel_id") REFERENCES "Novel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NovelCharacterRelation_source_character_id_fkey" FOREIGN KEY ("source_character_id") REFERENCES "Character" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NovelCharacterRelation_target_character_id_fkey" FOREIGN KEY ("target_character_id") REFERENCES "Character" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Character" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "gender" TEXT NOT NULL DEFAULT '',
    "age" TEXT NOT NULL DEFAULT '',
    "appearance" TEXT NOT NULL DEFAULT '',
    "first_person" TEXT NOT NULL DEFAULT '',
    "address_others" TEXT NOT NULL DEFAULT '',
    "speech_examples" TEXT NOT NULL DEFAULT '[]',
    "description" TEXT NOT NULL DEFAULT '',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);
INSERT INTO "new_Character" ("age", "appearance", "created_at", "description", "id", "name", "updated_at") SELECT "age", "appearance", "created_at", "description", "id", "name", "updated_at" FROM "Character";
DROP TABLE "Character";
ALTER TABLE "new_Character" RENAME TO "Character";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "NovelCharacter_character_id_idx" ON "NovelCharacter"("character_id");

-- CreateIndex
CREATE INDEX "NovelCharacterRelation_novel_id_idx" ON "NovelCharacterRelation"("novel_id");

