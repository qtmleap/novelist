import type { Prisma, PrismaClient } from '@/generated/prisma/client'
import type { CharacterVariantInput, CreateCharacterInput } from '@/schemas/character.dto'

// ベース (Character 本体) のフィールドを DB 形に。variants は別テーブルなので含めない。
function serializeBase(input: CreateCharacterInput) {
  return {
    name: input.name,
    gender: input.gender,
    age: input.age,
    occupation: input.occupation,
    appearance: input.appearance,
    first_person: input.first_person,
    address_others: input.address_others,
    speech_examples: JSON.stringify(input.speech_examples),
    description: input.description
  }
}

function parseSpeech(json: string): string[] {
  try {
    const parsed = JSON.parse(json)
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    // malformed stored value — return empty array
  }
  return []
}

// DB 行を API/フロント向けの形 (speech_examples を配列化、variants を整形) に変換する。
// 行の型は Prisma 生成型から取り、独自定義はしない。
function shapeCharacter(row: Prisma.CharacterGetPayload<{ include: { variants: true } }>) {
  return {
    ...row,
    speech_examples: parseSpeech(row.speech_examples),
    variants: row.variants.map((v) => ({
      id: v.id,
      label: v.label,
      age: v.age,
      occupation: v.occupation,
      appearance: v.appearance,
      first_person: v.first_person,
      address_others: v.address_others,
      speech_examples: parseSpeech(v.speech_examples),
      description: v.description
    }))
  }
}

function shapeVariant(v: Prisma.CharacterVariantGetPayload<true>) {
  return {
    id: v.id,
    label: v.label,
    age: v.age,
    occupation: v.occupation,
    appearance: v.appearance,
    first_person: v.first_person,
    address_others: v.address_others,
    speech_examples: parseSpeech(v.speech_examples),
    description: v.description
  }
}

// 入力をバリエーション行の data 形に。
function variantData(input: CharacterVariantInput) {
  return {
    label: input.label,
    age: input.age,
    occupation: input.occupation,
    appearance: input.appearance,
    first_person: input.first_person,
    address_others: input.address_others,
    speech_examples: JSON.stringify(input.speech_examples),
    description: input.description
  }
}

export async function createCharacter(prisma: PrismaClient, input: CreateCharacterInput) {
  // バリエーションは別エンドポイントで管理するので本体作成では触らない。
  const character = await prisma.character.create({ data: serializeBase(input) })
  const created = await getCharacter(prisma, character.id)
  // 直前に作成しているので必ず存在する。
  if (created === null) throw new Error('character disappeared after create')
  return created
}

// 末尾に追加 (position = 既存最大 + 1)。
export async function createVariant(prisma: PrismaClient, characterId: string, input: CharacterVariantInput) {
  const agg = await prisma.characterVariant.aggregate({
    where: { character_id: characterId },
    _max: { position: true }
  })
  const maxPos = agg._max.position
  const position = maxPos === null ? 0 : maxPos + 1
  const row = await prisma.characterVariant.create({
    data: { character_id: characterId, position, ...variantData(input) }
  })
  return shapeVariant(row)
}

// character_id でスコープして更新 (他キャラの variant を触らない)。無ければ null。
export async function updateVariant(
  prisma: PrismaClient,
  characterId: string,
  variantId: string,
  input: CharacterVariantInput
) {
  const result = await prisma.characterVariant.updateMany({
    where: { id: variantId, character_id: characterId },
    data: variantData(input)
  })
  if (result.count === 0) return null
  const row = await prisma.characterVariant.findUnique({ where: { id: variantId } })
  return row === null ? null : shapeVariant(row)
}

export async function deleteVariant(prisma: PrismaClient, characterId: string, variantId: string) {
  await prisma.characterVariant.deleteMany({ where: { id: variantId, character_id: characterId } })
}

export async function listCharacters(prisma: PrismaClient) {
  const rows = await prisma.character.findMany({
    orderBy: { created_at: 'desc' },
    include: { variants: { orderBy: { position: 'asc' } } }
  })
  return rows.map(shapeCharacter)
}

export async function getCharacter(prisma: PrismaClient, id: string) {
  const row = await prisma.character.findUnique({
    where: { id },
    include: { variants: { orderBy: { position: 'asc' } } }
  })
  if (!row) return null
  return shapeCharacter(row)
}

export async function updateCharacter(prisma: PrismaClient, id: string, input: CreateCharacterInput) {
  // バリエーションは別エンドポイントで管理するので本体更新では触らない。
  await prisma.character.update({ where: { id }, data: serializeBase(input) })
  const updated = await getCharacter(prisma, id)
  if (updated === null) throw new Error('character disappeared after update')
  return updated
}

export async function deleteCharacter(prisma: PrismaClient, id: string) {
  return prisma.character.delete({ where: { id } })
}
