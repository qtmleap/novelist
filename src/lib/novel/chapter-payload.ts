import type { PrismaClient } from '@/generated/prisma/client'
import type { StartChapterGenPayload } from '@/lib/chapter-gen-do'
import type { CastMember, CastRelation } from '@/lib/gemini/client'
import { getNovelWithChapters } from '@/lib/novel/repository'
import type { GeminiModel } from '@/schemas/novel.dto'
import { OutlineSchema } from '@/schemas/novel.dto'

export function buildCastForGemini(
  characterLinks: Array<{
    character_id: string
    role: string
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
    }
  }>
): CastMember[] {
  return characterLinks.map((l) => {
    let speech: string[] = []
    try {
      const parsed = JSON.parse(l.character.speech_examples)
      if (Array.isArray(parsed)) speech = parsed.filter((s) => typeof s === 'string')
    } catch {
      // malformed stored value — skip
    }
    return {
      name: l.character.name,
      role: l.role,
      gender: l.character.gender,
      age: l.character.age,
      occupation: l.character.occupation,
      appearance: l.character.appearance,
      first_person: l.character.first_person,
      address_others: l.character.address_others,
      speech_examples: speech,
      description: l.character.description
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

  const povChar = novel.pov_character_id
    ? novel.character_links.find((l) => l.character_id === novel.pov_character_id)?.character
    : undefined

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
      viewpointChar: povChar ? { name: povChar.name, first_person: povChar.first_person } : undefined
    },
    cast: buildCastForGemini(novel.character_links),
    relations: buildRelationsForGemini(novel.relations)
  }
}
