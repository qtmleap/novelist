-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CharacterStage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "character_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "label" TEXT NOT NULL,
    "age" TEXT NOT NULL DEFAULT '',
    "occupation" TEXT NOT NULL DEFAULT '',
    "appearance" TEXT NOT NULL DEFAULT '',
    "first_person" TEXT NOT NULL DEFAULT '',
    "address_others" TEXT NOT NULL DEFAULT '',
    "speech_examples" TEXT NOT NULL DEFAULT '[]',
    "description" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "CharacterStage_character_id_fkey" FOREIGN KEY ("character_id") REFERENCES "Character" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_CharacterStage" ("appearance", "character_id", "description", "id", "label", "position", "speech_examples") SELECT "appearance", "character_id", "description", "id", "label", "position", "speech_examples" FROM "CharacterStage";
DROP TABLE "CharacterStage";
ALTER TABLE "new_CharacterStage" RENAME TO "CharacterStage";
CREATE INDEX "CharacterStage_character_id_idx" ON "CharacterStage"("character_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

