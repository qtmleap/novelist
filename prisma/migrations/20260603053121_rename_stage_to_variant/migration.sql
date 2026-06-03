-- CharacterStage を CharacterVariant にリネーム (データ保持)。
-- prisma migrate diff は drop/create を出すが、リネームなので ALTER に置き換える。
ALTER TABLE "CharacterStage" RENAME TO "CharacterVariant";
DROP INDEX IF EXISTS "CharacterStage_character_id_idx";
CREATE INDEX "CharacterVariant_character_id_idx" ON "CharacterVariant"("character_id");
