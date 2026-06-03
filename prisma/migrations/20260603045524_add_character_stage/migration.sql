-- CreateTable
CREATE TABLE "CharacterStage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "character_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "label" TEXT NOT NULL,
    "appearance" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "speech_examples" TEXT NOT NULL DEFAULT '[]',
    CONSTRAINT "CharacterStage_character_id_fkey" FOREIGN KEY ("character_id") REFERENCES "Character" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "CharacterStage_character_id_idx" ON "CharacterStage"("character_id");

