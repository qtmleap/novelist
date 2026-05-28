-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_NovelCharacterRelation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "novel_id" TEXT NOT NULL,
    "source_character_id" TEXT NOT NULL,
    "target_character_id" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "address_override" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "NovelCharacterRelation_novel_id_fkey" FOREIGN KEY ("novel_id") REFERENCES "Novel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NovelCharacterRelation_source_character_id_fkey" FOREIGN KEY ("source_character_id") REFERENCES "Character" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NovelCharacterRelation_target_character_id_fkey" FOREIGN KEY ("target_character_id") REFERENCES "Character" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_NovelCharacterRelation" ("description", "id", "novel_id", "relation", "source_character_id", "target_character_id") SELECT "description", "id", "novel_id", "relation", "source_character_id", "target_character_id" FROM "NovelCharacterRelation";
DROP TABLE "NovelCharacterRelation";
ALTER TABLE "new_NovelCharacterRelation" RENAME TO "NovelCharacterRelation";
CREATE INDEX "NovelCharacterRelation_novel_id_idx" ON "NovelCharacterRelation"("novel_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

