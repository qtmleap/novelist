import type { Prisma, PrismaClient } from '@/generated/prisma/client'
import type { CreateCharacterInput } from '@/schemas/character.dto'

// ベース (Character 本体) のフィールドを DB 形に。stages は別テーブルなので含めない。
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

// DB 行を API/フロント向けの形 (speech_examples を配列化、stages を整形) に変換する。
// 行の型は Prisma 生成型から取り、独自定義はしない。
function shapeCharacter(row: Prisma.CharacterGetPayload<{ include: { stages: true } }>) {
  return {
    ...row,
    speech_examples: parseSpeech(row.speech_examples),
    stages: row.stages.map((s) => ({
      id: s.id,
      label: s.label,
      age: s.age,
      occupation: s.occupation,
      appearance: s.appearance,
      first_person: s.first_person,
      address_others: s.address_others,
      speech_examples: parseSpeech(s.speech_examples),
      description: s.description
    }))
  }
}

// 成長段階を position 付きで作成する $transaction オペレーション群を作る。
function stageCreateOps(prisma: PrismaClient, characterId: string, stages: CreateCharacterInput['stages']) {
  return stages.map((s, i) =>
    prisma.characterStage.create({
      data: {
        character_id: characterId,
        position: i,
        label: s.label,
        age: s.age,
        occupation: s.occupation,
        appearance: s.appearance,
        first_person: s.first_person,
        address_others: s.address_others,
        speech_examples: JSON.stringify(s.speech_examples),
        description: s.description
      }
    })
  )
}

export async function createCharacter(prisma: PrismaClient, input: CreateCharacterInput) {
  const character = await prisma.character.create({ data: serializeBase(input) })
  const ops = stageCreateOps(prisma, character.id, input.stages)
  if (ops.length > 0) await prisma.$transaction(ops)
  const created = await getCharacter(prisma, character.id)
  // 直前に作成しているので必ず存在する。
  if (created === null) throw new Error('character disappeared after create')
  return created
}

export async function listCharacters(prisma: PrismaClient) {
  const rows = await prisma.character.findMany({
    orderBy: { created_at: 'desc' },
    include: { stages: { orderBy: { position: 'asc' } } }
  })
  return rows.map(shapeCharacter)
}

export async function getCharacter(prisma: PrismaClient, id: string) {
  const row = await prisma.character.findUnique({
    where: { id },
    include: { stages: { orderBy: { position: 'asc' } } }
  })
  if (!row) return null
  return shapeCharacter(row)
}

export async function updateCharacter(prisma: PrismaClient, id: string, input: CreateCharacterInput) {
  // D1 はインタラクティブトランザクション非対応なので $transaction([...]) で順序実行。
  // 既存 stages は一旦消して input から入れ直す。
  const ops: Prisma.PrismaPromise<unknown>[] = [
    prisma.character.update({ where: { id }, data: serializeBase(input) }),
    prisma.characterStage.deleteMany({ where: { character_id: id } }),
    ...stageCreateOps(prisma, id, input.stages)
  ]
  await prisma.$transaction(ops)
  const updated = await getCharacter(prisma, id)
  if (updated === null) throw new Error('character disappeared after update')
  return updated
}

export async function deleteCharacter(prisma: PrismaClient, id: string) {
  return prisma.character.delete({ where: { id } })
}
