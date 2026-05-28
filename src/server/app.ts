import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import {
  createCharacter,
  deleteCharacter,
  getCharacter,
  listCharacters,
  updateCharacter
} from '@/lib/character/repository'
import { getEnv, getPrisma } from '@/lib/db'
import type { CastMember, CastRelation } from '@/lib/gemini/client'
import { computeCostUsd, generateOutline, regenerateOutlineChapter, streamChapter } from '@/lib/gemini/client'
import {
  createNovel,
  deleteNovel,
  getNovelWithChapters,
  listNovels,
  saveChapter,
  saveOutline,
  updateNovel
} from '@/lib/novel/repository'
import { CreateCharacterSchema } from '@/schemas/character.dto'
import { CreateNovelSchema, GenerateOptionsSchema, OutlineSchema } from '@/schemas/novel.dto'

function serializeNovel(n: {
  id: string
  title: string
  genre: string
  characters: string
  setting: string
  num_chapters: number
  target_chars: number
  pov: string
  tone: string
  pov_character_id: string
  ending: string
  outline: string | null
  created_at: Date
  updated_at: Date
}) {
  return {
    id: n.id,
    title: n.title,
    genre: n.genre,
    characters: n.characters,
    setting: n.setting,
    num_chapters: n.num_chapters,
    target_chars: n.target_chars,
    pov: n.pov,
    tone: n.tone,
    pov_character_id: n.pov_character_id,
    ending: n.ending,
    outline: n.outline,
    created_at: n.created_at.toISOString(),
    updated_at: n.updated_at.toISOString()
  }
}

// Gemini プロンプト用に NovelWithChapters.character_links / relations を
// 辞典フィールド込みの CastMember[] / CastRelation[] に変換する。
// speech_examples は DB では JSON 文字列で持っているのでここでパースする。
function buildCastForGemini(
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

function buildRelationsForGemini(
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

function serializeCharacter(c: {
  id: string
  name: string
  gender: string
  age: string
  occupation: string
  appearance: string
  first_person: string
  address_others: string
  speech_examples: string[]
  description: string
  created_at: Date
  updated_at: Date
}) {
  return {
    id: c.id,
    name: c.name,
    gender: c.gender,
    age: c.age,
    occupation: c.occupation,
    appearance: c.appearance,
    first_person: c.first_person,
    address_others: c.address_others,
    speech_examples: c.speech_examples,
    description: c.description,
    created_at: c.created_at.toISOString(),
    updated_at: c.updated_at.toISOString()
  }
}

// NOTE: all routes are chained on a single builder so that `typeof app` includes
// every endpoint's input/output schema. The Hono client (hc<AppType>) relies on
// this — re-assigning `app.get(...)` instead of chaining loses type inference.
export const app = new Hono()
  .basePath('/api')

  // ── Novels ────────────────────────────────────────────────────────────
  .get('/novels', async (c) => {
    const prisma = getPrisma()
    try {
      const novels = await listNovels(prisma)
      return c.json(novels.map(serializeNovel))
    } finally {
      await prisma.$disconnect()
    }
  })
  .post('/novels', zValidator('json', CreateNovelSchema), async (c) => {
    const input = c.req.valid('json')
    const prisma = getPrisma()
    try {
      const novel = await createNovel(prisma, input)
      return c.json(serializeNovel(novel), 201)
    } finally {
      await prisma.$disconnect()
    }
  })

  .get('/novels/:id', async (c) => {
    const id = c.req.param('id')
    const prisma = getPrisma()
    try {
      const novel = await getNovelWithChapters(prisma, id)
      if (!novel) return c.json({ error: 'not_found' }, 404)
      return c.json({
        ...serializeNovel(novel),
        chapters: novel.chapters.map((ch) => ({
          id: ch.id,
          novel_id: ch.novel_id,
          chapter_number: ch.chapter_number,
          title: ch.title,
          content: ch.content,
          created_at: ch.created_at.toISOString()
        })),
        cast: novel.cast,
        relations: novel.relations,
        generation_costs: novel.generation_costs,
        total_cost_usd: novel.total_cost_usd
      })
    } finally {
      await prisma.$disconnect()
    }
  })
  .put('/novels/:id', zValidator('json', CreateNovelSchema), async (c) => {
    const id = c.req.param('id')
    const input = c.req.valid('json')
    const prisma = getPrisma()
    try {
      const novel = await updateNovel(prisma, id, input)
      return c.json(serializeNovel(novel))
    } catch (e) {
      const err = e as { code?: string }
      if (err.code === 'P2025') return c.json({ error: 'not_found' }, 404)
      throw e
    } finally {
      await prisma.$disconnect()
    }
  })
  .delete('/novels/:id', async (c) => {
    const id = c.req.param('id')
    const prisma = getPrisma()
    try {
      await deleteNovel(prisma, id)
      return c.body(null, 204)
    } catch (e) {
      const err = e as { code?: string }
      if (err.code === 'P2025') return c.json({ error: 'not_found' }, 404)
      throw e
    } finally {
      await prisma.$disconnect()
    }
  })

  .post('/novels/:id/outline', zValidator('json', GenerateOptionsSchema), async (c) => {
    const id = c.req.param('id')
    const options = c.req.valid('json')
    const prisma = getPrisma()
    try {
      const novel = await getNovelWithChapters(prisma, id)
      if (!novel) return c.json({ error: 'not_found' }, 404)

      const env = getEnv()
      const povChar = novel.pov_character_id
        ? novel.character_links.find((l) => l.character_id === novel.pov_character_id)?.character
        : undefined
      const style = {
        pov: novel.pov,
        tone: novel.tone,
        ending: novel.ending,
        viewpointChar: povChar ? { name: povChar.name, first_person: povChar.first_person } : undefined
      }
      const cast = buildCastForGemini(novel.character_links)
      const relations = buildRelationsForGemini(novel.relations)
      try {
        const outline = await generateOutline(
          env,
          {
            title: novel.title,
            genre: novel.genre,
            characters: novel.characters,
            setting: novel.setting,
            num_chapters: novel.num_chapters
          },
          style,
          options.model,
          cast,
          relations
        )
        await saveOutline(prisma, id, JSON.stringify(outline))
        return c.json({ outline })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return c.json({ error: 'generation_failed', detail: msg }, 502)
      }
    } finally {
      await prisma.$disconnect()
    }
  })

  .post('/novels/:id/outline/:number', zValidator('json', GenerateOptionsSchema), async (c) => {
    const id = c.req.param('id')
    const chapterNumber = Number.parseInt(c.req.param('number'), 10)
    if (Number.isNaN(chapterNumber) || chapterNumber < 1) {
      return c.json({ error: 'invalid_chapter_number' }, 400)
    }
    const options = c.req.valid('json')
    const prisma = getPrisma()
    try {
      const novel = await getNovelWithChapters(prisma, id)
      if (!novel) return c.json({ error: 'not_found' }, 404)
      if (!novel.outline) return c.json({ error: 'outline_not_generated' }, 400)

      const parsedOutline = OutlineSchema.safeParse(JSON.parse(novel.outline))
      if (!parsedOutline.success) return c.json({ error: 'invalid_outline' }, 500)

      const env = getEnv()
      const povChar = novel.pov_character_id
        ? novel.character_links.find((l) => l.character_id === novel.pov_character_id)?.character
        : undefined
      const style = {
        pov: novel.pov,
        tone: novel.tone,
        ending: novel.ending,
        viewpointChar: povChar ? { name: povChar.name, first_person: povChar.first_person } : undefined
      }
      const cast = buildCastForGemini(novel.character_links)
      const relations = buildRelationsForGemini(novel.relations)

      try {
        const next = await regenerateOutlineChapter(
          env,
          {
            title: novel.title,
            genre: novel.genre,
            characters: novel.characters,
            setting: novel.setting,
            num_chapters: novel.num_chapters
          },
          style,
          parsedOutline.data,
          chapterNumber,
          options.model,
          cast,
          relations
        )
        const merged = {
          chapters: parsedOutline.data.chapters.map((ch) => (ch.chapter_number === chapterNumber ? next : ch))
        }
        await saveOutline(prisma, id, JSON.stringify(merged))
        // 章立て (タイトル・要約) と本文がずれた状態は混乱の元なので、
        // 章立てを上書きしたらこの章の本文も全 version 削除する。
        await prisma.chapter.deleteMany({ where: { novel_id: id, chapter_number: chapterNumber } })
        return c.json({ outline: merged })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return c.json({ error: 'generation_failed', detail: msg }, 502)
      }
    } finally {
      await prisma.$disconnect()
    }
  })

  // SSE — response is a text/event-stream so hc client treats it as a raw Response.
  .post('/novels/:id/chapters/:number/generate', zValidator('json', GenerateOptionsSchema), async (c) => {
    const id = c.req.param('id')
    const chapterNumber = Number.parseInt(c.req.param('number'), 10)
    if (Number.isNaN(chapterNumber) || chapterNumber < 1) {
      return c.json({ error: 'invalid_chapter_number' }, 400)
    }

    const options = c.req.valid('json')
    const prisma = getPrisma()

    let novel: Awaited<ReturnType<typeof getNovelWithChapters>>
    try {
      novel = await getNovelWithChapters(prisma, id)
    } catch {
      await prisma.$disconnect()
      return c.json({ error: 'db_error' }, 500)
    }
    if (!novel) {
      await prisma.$disconnect()
      return c.json({ error: 'not_found' }, 404)
    }
    if (!novel.outline) {
      await prisma.$disconnect()
      return c.json({ error: 'outline_not_generated' }, 400)
    }

    let outlineParsed: ReturnType<typeof OutlineSchema.safeParse>
    try {
      outlineParsed = OutlineSchema.safeParse(JSON.parse(novel.outline))
    } catch {
      await prisma.$disconnect()
      return c.json({ error: 'invalid_outline' }, 500)
    }
    if (!outlineParsed.success) {
      await prisma.$disconnect()
      return c.json({ error: 'invalid_outline' }, 500)
    }

    const outline = outlineParsed.data
    const targetEntry = outline.chapters.find((ch) => ch.chapter_number === chapterNumber)
    if (!targetEntry) {
      await prisma.$disconnect()
      return c.json({ error: 'chapter_not_in_outline' }, 400)
    }

    const previousChapters = novel.chapters
      .filter((ch) => ch.chapter_number < chapterNumber)
      .sort((a, b) => a.chapter_number - b.chapter_number)
      .slice(-2)
      .map((ch) => ({ chapter_number: ch.chapter_number, content: ch.content }))

    const env = getEnv()
    const povChar = novel.pov_character_id
      ? novel.character_links.find((l) => l.character_id === novel.pov_character_id)?.character
      : undefined
    const style = {
      pov: novel.pov,
      tone: novel.tone,
      ending: novel.ending,
      viewpointChar: povChar ? { name: povChar.name, first_person: povChar.first_person } : undefined
    }

    const cast = buildCastForGemini(novel.character_links)
    const relations = buildRelationsForGemini(novel.relations)

    let geminiResult: ReturnType<typeof streamChapter>
    try {
      geminiResult = streamChapter(env, {
        novel: {
          title: novel.title,
          genre: novel.genre,
          characters: novel.characters,
          setting: novel.setting,
          num_chapters: novel.num_chapters
        },
        outline,
        chapterNumber,
        previousChapters,
        targetChars: novel.target_chars,
        style,
        cast,
        relations,
        model: options.model
      })
    } catch (e) {
      await prisma.$disconnect()
      const msg = e instanceof Error ? e.message : String(e)
      return c.json({ error: msg }, 500)
    }

    const { stream: geminiStream, usage: usagePromise } = geminiResult

    c.header('X-Accel-Buffering', 'no')
    return streamSSE(c, async (stream) => {
      const reader = geminiStream.getReader()
      const decoder = new TextDecoder()
      let accumulated = ''
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const delta = decoder.decode(value, { stream: true })
          accumulated += delta
          await stream.writeSSE({ data: JSON.stringify({ delta }) })
        }

        const chapterTitle = targetEntry.title
        let saved: { id: string }
        try {
          saved = await saveChapter(prisma, id, chapterNumber, accumulated, chapterTitle)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          await stream.writeSSE({ data: JSON.stringify({ error: `save_failed: ${msg}` }) })
          return
        }

        try {
          const usage = await usagePromise
          const costUsd = computeCostUsd(usage.model, usage.promptTokens, usage.outputTokens)
          await prisma.chapterGenerationCost.create({
            data: {
              novel_id: id,
              chapter_number: chapterNumber,
              model: usage.model,
              prompt_tokens: usage.promptTokens,
              output_tokens: usage.outputTokens,
              cost_usd: costUsd
            }
          })
        } catch {
          // cost recording is best-effort
        }

        await stream.writeSSE({
          data: JSON.stringify({ done: true, chapterId: saved.id, title: chapterTitle })
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        await stream.writeSSE({ data: JSON.stringify({ error: msg }) })
      } finally {
        reader.releaseLock()
        await prisma.$disconnect()
      }
    })
  })

  // 章本文の削除。整合性を保つため「最新の生成済み章」しか消せない (後続を消さないと前章を消す意味がないので)。
  .delete('/novels/:id/chapters/:number', async (c) => {
    const id = c.req.param('id')
    const chapterNumber = Number.parseInt(c.req.param('number'), 10)
    if (Number.isNaN(chapterNumber) || chapterNumber < 1) {
      return c.json({ error: 'invalid_chapter_number' }, 400)
    }
    const prisma = getPrisma()
    try {
      const latest = await prisma.chapter.findFirst({
        where: { novel_id: id },
        orderBy: { chapter_number: 'desc' },
        select: { chapter_number: true }
      })
      if (!latest) return c.json({ error: 'no_chapters' }, 404)
      if (latest.chapter_number !== chapterNumber) {
        return c.json({ error: 'not_latest_chapter' }, 409)
      }
      await prisma.chapter.deleteMany({ where: { novel_id: id, chapter_number: chapterNumber } })
      return c.body(null, 204)
    } finally {
      await prisma.$disconnect()
    }
  })

  // ── Characters ───────────────────────────────────────────────────────
  .get('/characters', async (c) => {
    const prisma = getPrisma()
    try {
      const characters = await listCharacters(prisma)
      return c.json(characters.map(serializeCharacter))
    } finally {
      await prisma.$disconnect()
    }
  })
  .post('/characters', zValidator('json', CreateCharacterSchema), async (c) => {
    const input = c.req.valid('json')
    const prisma = getPrisma()
    try {
      const character = await createCharacter(prisma, input)
      return c.json(serializeCharacter(character), 201)
    } finally {
      await prisma.$disconnect()
    }
  })

  .get('/characters/:id', async (c) => {
    const id = c.req.param('id')
    const prisma = getPrisma()
    try {
      const character = await getCharacter(prisma, id)
      if (!character) return c.json({ error: 'not_found' }, 404)
      return c.json(serializeCharacter(character))
    } finally {
      await prisma.$disconnect()
    }
  })
  .put('/characters/:id', zValidator('json', CreateCharacterSchema), async (c) => {
    const id = c.req.param('id')
    const input = c.req.valid('json')
    const prisma = getPrisma()
    try {
      const character = await updateCharacter(prisma, id, input)
      return c.json(serializeCharacter(character))
    } catch (e) {
      const err = e as { code?: string }
      if (err.code === 'P2025') return c.json({ error: 'not_found' }, 404)
      throw e
    } finally {
      await prisma.$disconnect()
    }
  })
  .delete('/characters/:id', async (c) => {
    const id = c.req.param('id')
    const prisma = getPrisma()
    try {
      await deleteCharacter(prisma, id)
      return c.body(null, 204)
    } catch (e) {
      const err = e as { code?: string }
      if (err.code === 'P2025') return c.json({ error: 'not_found' }, 404)
      throw e
    } finally {
      await prisma.$disconnect()
    }
  })

export type AppType = typeof app
