import type { PrismaClient } from '@/generated/prisma/client'
import type { StartChapterGenPayload } from '@/lib/chapter-gen-do'
import type { CastMember, CastRelation } from '@/lib/gemini/client'
import { getNovelWithChapters } from '@/lib/novel/repository'
import type { GeminiModel } from '@/schemas/novel.dto'
import { OutlineSchema } from '@/schemas/novel.dto'

// バリエーション (variant) の生フィールド。name/gender は variant では不変なので持たない。
type VariantFields = {
  id: string
  age: string
  occupation: string
  appearance: string
  first_person: string
  address_others: string
  speech_examples: string
  description: string
}

// getNovelWithChapters が返す character_links の要素 (variant 込み)。
type CharacterLink = {
  character_id: string
  role: string
  variant_id: string | null
  character: {
    name: string
    gender: string
    age: string
    occupation: string
    appearance: string
    first_person: string
    address_others: string
    speech_examples: string
    description: string
    variants: VariantFields[]
  }
}

type EffectiveCharacter = {
  name: string
  gender: string
  age: string
  occupation: string
  appearance: string
  first_person: string
  address_others: string
  speech_examples: string
  description: string
}

// variant_id が指す variant の非空フィールドをベースに重ねる (name/gender は不変)。
// variant が見つからない (削除済み等) ときはベースのまま返す。
function effectiveCharacter(link: CharacterLink): EffectiveCharacter {
  const base = link.character
  if (link.variant_id === null) return base
  const v = base.variants.find((x) => x.id === link.variant_id)
  if (v === undefined) return base
  const pick = (variantValue: string, baseValue: string) => (variantValue !== '' ? variantValue : baseValue)
  // speech_examples は JSON 文字列。空配列 '[]' は未設定としてベース継承する。
  const speech = v.speech_examples !== '' && v.speech_examples !== '[]' ? v.speech_examples : base.speech_examples
  return {
    name: base.name,
    gender: base.gender,
    age: pick(v.age, base.age),
    occupation: pick(v.occupation, base.occupation),
    appearance: pick(v.appearance, base.appearance),
    first_person: pick(v.first_person, base.first_person),
    address_others: pick(v.address_others, base.address_others),
    speech_examples: speech,
    description: pick(v.description, base.description)
  }
}

// 視点キャラの表示用 (選択 variant をマージした名前・一人称)。未指定なら undefined。
export function viewpointCharFor(
  characterLinks: CharacterLink[],
  povCharacterId: string
): { name: string; first_person: string } | undefined {
  if (povCharacterId === '') return undefined
  const link = characterLinks.find((l) => l.character_id === povCharacterId)
  if (link === undefined) return undefined
  const eff = effectiveCharacter(link)
  return { name: eff.name, first_person: eff.first_person }
}

export function buildCastForGemini(characterLinks: CharacterLink[]): CastMember[] {
  return characterLinks.map((l) => {
    const eff = effectiveCharacter(l)
    let speech: string[] = []
    try {
      const parsed = JSON.parse(eff.speech_examples)
      if (Array.isArray(parsed)) speech = parsed.filter((s) => typeof s === 'string')
    } catch {
      // malformed stored value — skip
    }
    return {
      name: eff.name,
      role: l.role,
      gender: eff.gender,
      age: eff.age,
      occupation: eff.occupation,
      appearance: eff.appearance,
      first_person: eff.first_person,
      address_others: eff.address_others,
      speech_examples: speech,
      description: eff.description
    }
  })
}

export function buildRelationsForGemini(
  relations: Array<{
    source_name: string
    target_name: string
    relation: string
    description: string
    address_override: string
  }>
): CastRelation[] {
  return relations.map((r) => ({
    source_name: r.source_name,
    target_name: r.target_name,
    relation: r.relation,
    description: r.description,
    address_override: r.address_override
  }))
}

export async function buildChapterPayload(
  prisma: PrismaClient,
  novelId: string,
  chapterNumber: number,
  model: GeminiModel
): Promise<StartChapterGenPayload | null> {
  const novel = await getNovelWithChapters(prisma, novelId)
  if (!novel) return null
  if (!novel.outline) return null

  let outline: import('@/schemas/novel.dto').Outline
  try {
    const parsed = OutlineSchema.safeParse(JSON.parse(novel.outline))
    if (!parsed.success) return null
    outline = parsed.data
  } catch {
    return null
  }

  const targetEntry = outline.chapters.find((ch) => ch.chapter_number === chapterNumber)
  if (!targetEntry) return null

  const previousChapters = novel.chapters
    .filter((ch) => ch.chapter_number < chapterNumber)
    .sort((a, b) => a.chapter_number - b.chapter_number)
    .slice(-2)
    .map((ch) => ({ chapter_number: ch.chapter_number, content: ch.content }))

  const viewpointChar = viewpointCharFor(novel.character_links, novel.pov_character_id)

  return {
    novelId,
    chapterNumber,
    chapterTitle: targetEntry.title,
    targetChars: novel.target_chars,
    model,
    novel: {
      title: novel.title,
      genre: novel.genre,
      setting: novel.setting,
      num_chapters: novel.num_chapters,
      notes: novel.notes
    },
    outline,
    previousChapters,
    style: {
      pov: novel.pov,
      tone: novel.tone,
      age_rating: novel.age_rating,
      ending: novel.ending,
      viewpointChar
    },
    cast: buildCastForGemini(novel.character_links),
    relations: buildRelationsForGemini(novel.relations)
  }
}
