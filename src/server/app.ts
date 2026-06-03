import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  createCharacter,
  deleteCharacter,
  getCharacter,
  listCharacters,
  updateCharacter
} from '@/lib/character/repository'
import { getEnv, getPrisma } from '@/lib/db'
import { buildOutlinePrompt, generateOutline, regenerateOutlineChapter } from '@/lib/gemini/client'
import { buildCastForGemini, buildChapterPayload, buildRelationsForGemini } from '@/lib/novel/chapter-payload'
import {
  createCategory,
  createNovel,
  deleteCategory,
  deleteNovel,
  getNovelWithChapters,
  listCategories,
  listNovels,
  renameCategory,
  saveOutline,
  stopGenerationJob,
  updateNovel,
  upsertGenerationJob
} from '@/lib/novel/repository'
import { CreateCharacterSchema } from '@/schemas/character.dto'
import {
  CreateCategorySchema,
  CreateNovelSchema,
  GeminiModelSchema,
  GenerateOptionsSchema,
  GenerateOutlineOptionsSchema,
  OutlineSchema
} from '@/schemas/novel.dto'
import { readAuthEmail, requireAuth } from '@/server/auth'

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
  age_rating: string
  pov_character_id: string
  ending: string
  notes: string
  editor_model: string
  writer_model: string
  outline: string | null
  category_id: string | null
  category: { name: string } | null
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
    age_rating: n.age_rating,
    pov_character_id: n.pov_character_id,
    ending: n.ending,
    notes: n.notes,
    editor_model: n.editor_model,
    writer_model: n.writer_model,
    // DB の JSON 文字列をパース・検証してオブジェクトで返す。未生成 (null) や壊れた JSON は null。
    outline: parseStoredOutline(n.outline),
    category_id: n.category_id,
    category_name: n.category ? n.category.name : null,
    created_at: n.created_at.toISOString(),
    updated_at: n.updated_at.toISOString()
  }
}

// DB に保存された outline (JSON 文字列 | null) を OutlineSchema で検証して返す。
// 壊れていれば null にフォールバックし、API レスポンスは常に Outline | null で一貫させる。
function parseStoredOutline(raw: string | null): z.infer<typeof OutlineSchema> | null {
  if (raw === null || raw.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const result = OutlineSchema.safeParse(parsed)
  return result.success ? result.data : null
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

  // ── Categories (ユーザー作成のフォルダ式カテゴリ) ──────────────────────
  .get('/categories', async (c) => {
    const prisma = getPrisma()
    try {
      const categories = await listCategories(prisma)
      return c.json(categories.map((cat) => ({ id: cat.id, name: cat.name, novel_count: cat._count.novels })))
    } finally {
      await prisma.$disconnect()
    }
  })
  .post('/categories', requireAuth, zValidator('json', CreateCategorySchema), async (c) => {
    const input = c.req.valid('json')
    const prisma = getPrisma()
    try {
      const category = await createCategory(prisma, input.name)
      return c.json({ id: category.id, name: category.name, novel_count: 0 }, 201)
    } finally {
      await prisma.$disconnect()
    }
  })
  .put('/categories/:id', requireAuth, zValidator('json', CreateCategorySchema), async (c) => {
    const id = c.req.param('id')
    const input = c.req.valid('json')
    const prisma = getPrisma()
    try {
      const result = await renameCategory(prisma, id, input.name)
      if (result.status === 'name_taken') return c.json({ error: 'name_taken' }, 409)
      if (result.status === 'not_found') return c.json({ error: 'not_found' }, 404)
      return c.json(result.category)
    } finally {
      await prisma.$disconnect()
    }
  })
  .delete('/categories/:id', requireAuth, async (c) => {
    const id = c.req.param('id')
    const prisma = getPrisma()
    try {
      await deleteCategory(prisma, id)
      return c.json({ id })
    } finally {
      await prisma.$disconnect()
    }
  })

  .post('/novels', requireAuth, zValidator('json', CreateNovelSchema), async (c) => {
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
        total_cost_usd: novel.total_cost_usd,
        gen_job: novel.generation_job
          ? (() => {
              const parsed: unknown = JSON.parse(novel.generation_job.pending)
              const pending = Array.isArray(parsed) ? parsed.filter((x): x is number => typeof x === 'number') : []
              return { status: novel.generation_job.status, current: novel.generation_job.current, pending }
            })()
          : null
      })
    } finally {
      await prisma.$disconnect()
    }
  })
  .put('/novels/:id', requireAuth, zValidator('json', CreateNovelSchema), async (c) => {
    const id = c.req.param('id')
    const input = c.req.valid('json')
    const prisma = getPrisma()
    try {
      const existing = await prisma.novel.findUnique({ where: { id }, select: { num_chapters: true } })
      if (!existing) return c.json({ error: 'not_found' }, 404)
      // 章数を減らすと既存章本文が宙ぶらりんになるので拒否。増やすのは OK。
      if (input.num_chapters < existing.num_chapters) {
        return c.json({ error: 'num_chapters_cannot_decrease', current: existing.num_chapters }, 409)
      }
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
  .delete('/novels/:id', requireAuth, async (c) => {
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

  .post('/novels/:id/outline', requireAuth, zValidator('json', GenerateOutlineOptionsSchema), async (c) => {
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
        age_rating: novel.age_rating,
        ending: novel.ending,
        viewpointChar: povChar ? { name: povChar.name, first_person: povChar.first_person } : undefined
      }
      const cast = buildCastForGemini(novel.character_links)
      const relations = buildRelationsForGemini(novel.relations)

      const params = {
        title: novel.title,
        genre: novel.genre,
        characters: novel.characters,
        setting: novel.setting,
        num_chapters: novel.num_chapters,
        notes: novel.notes
      }

      // 既存 outline がある + chapters[] 指定 (かつ全章ではない) → 部分再生成。
      // それ以外 (= 初回 / 指定なし / 全章指定) → 全章まとめて生成 (Worker のタイムアウト回避)。
      const existing = novel.outline ? OutlineSchema.safeParse(JSON.parse(novel.outline)) : null
      const targets = options.chapters?.filter((n) => n >= 1 && n <= novel.num_chapters)
      const canPartial =
        existing?.success === true && targets !== undefined && targets.length > 0 && targets.length < novel.num_chapters

      try {
        if (canPartial && existing.success) {
          // 既存の outline を保持しつつ、選択された章だけ生成し直してマージする。
          // 各章本文も整合性のため削除する (per-chapter outline regen と同じルール)。
          let merged = existing.data
          for (const n of targets) {
            const next = await regenerateOutlineChapter(env, params, style, merged, n, options.model, cast, relations)
            merged = {
              chapters: merged.chapters.map((ch) => (ch.chapter_number === n ? next : ch))
            }
            // 章番号が outline に存在しなかった場合は末尾に追加。
            if (!merged.chapters.some((ch) => ch.chapter_number === n)) {
              merged = { chapters: [...merged.chapters, next].sort((a, b) => a.chapter_number - b.chapter_number) }
            }
            await prisma.chapter.deleteMany({ where: { novel_id: id, chapter_number: n } })
          }
          await saveOutline(prisma, id, JSON.stringify(merged))
          return c.json({ outline: merged })
        }

        // 全章まとめて生成。既存本文は無効化されるので全削除。
        const outline = await generateOutline(env, params, style, options.model, cast, relations)
        await saveOutline(prisma, id, JSON.stringify(outline))
        await prisma.chapter.deleteMany({ where: { novel_id: id } })
        return c.json({ outline })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return c.json({ error: 'generation_failed', detail: msg }, 502)
      }
    } finally {
      await prisma.$disconnect()
    }
  })

  // 章立ての手動編集。AI 生成ではなくユーザーが直接 title/summary を書き換える経路。
  // 既存章本文には触らない (本文と outline がズレた場合は別途章本文を再生成する想定)。
  .put('/novels/:id/outline', requireAuth, zValidator('json', z.object({ outline: OutlineSchema })), async (c) => {
    const id = c.req.param('id')
    const { outline } = c.req.valid('json')
    const prisma = getPrisma()
    try {
      const existing = await prisma.novel.findUnique({ where: { id }, select: { id: true } })
      if (!existing) return c.json({ error: 'not_found' }, 404)
      await saveOutline(prisma, id, JSON.stringify(outline))
      return c.json({ outline })
    } finally {
      await prisma.$disconnect()
    }
  })

  // 章立て生成プロンプトのプレビュー (Gemini に投げる前の文字列を返す。デバッグ用)
  .get('/novels/:id/outline/preview', async (c) => {
    const id = c.req.param('id')
    const prisma = getPrisma()
    try {
      const novel = await getNovelWithChapters(prisma, id)
      if (!novel) return c.json({ error: 'not_found' }, 404)

      const povChar = novel.pov_character_id
        ? novel.character_links.find((l) => l.character_id === novel.pov_character_id)?.character
        : undefined
      const style = {
        pov: novel.pov,
        tone: novel.tone,
        age_rating: novel.age_rating,
        ending: novel.ending,
        viewpointChar: povChar ? { name: povChar.name, first_person: povChar.first_person } : undefined
      }
      const cast = buildCastForGemini(novel.character_links)
      const relations = buildRelationsForGemini(novel.relations)
      const params = {
        title: novel.title,
        genre: novel.genre,
        characters: novel.characters,
        setting: novel.setting,
        num_chapters: novel.num_chapters,
        notes: novel.notes
      }
      const prompt = buildOutlinePrompt(params, style, cast, relations)
      return c.json({ prompt })
    } finally {
      await prisma.$disconnect()
    }
  })

  // 章本文生成時に実際に Gemini へ送ったプロンプト (最新 version) を返す。
  // この機能より前に生成された章は prompt=null。
  .get('/novels/:id/chapters/:number/prompt', async (c) => {
    const id = c.req.param('id')
    const chapterNumber = Number.parseInt(c.req.param('number'), 10)
    if (Number.isNaN(chapterNumber) || chapterNumber < 1) {
      return c.json({ error: 'invalid_chapter_number' }, 400)
    }
    const prisma = getPrisma()
    try {
      const chapter = await prisma.chapter.findFirst({
        where: { novel_id: id, chapter_number: chapterNumber },
        orderBy: { version: 'desc' },
        select: { prompt: true }
      })
      if (!chapter) return c.json({ error: 'not_found' }, 404)
      return c.json({ prompt: chapter.prompt })
    } finally {
      await prisma.$disconnect()
    }
  })

  .post('/novels/:id/outline/:number', requireAuth, zValidator('json', GenerateOptionsSchema), async (c) => {
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
        age_rating: novel.age_rating,
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
            num_chapters: novel.num_chapters,
            notes: novel.notes
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

  // 生成キックオフ。Durable Object に payload を渡して即座に 202 を返す。
  // 生成自体は DO 内で fire-and-forget で走り続け、ページ離脱・タブ閉じでも止まらない。
  // クライアントは下の /stream エンドポイントで SSE 経由で進捗を受け取る。
  .post('/novels/:id/chapters/:number/generate', requireAuth, zValidator('json', GenerateOptionsSchema), async (c) => {
    const id = c.req.param('id')
    const chapterNumber = Number.parseInt(c.req.param('number'), 10)
    if (Number.isNaN(chapterNumber) || chapterNumber < 1) {
      return c.json({ error: 'invalid_chapter_number' }, 400)
    }

    const options = c.req.valid('json')
    const prisma = getPrisma()
    let payload: import('@/lib/chapter-gen-do').StartChapterGenPayload | null
    try {
      payload = await buildChapterPayload(
        prisma,
        id,
        chapterNumber,
        options.model !== undefined ? options.model : GeminiModelSchema.enum['gemini-2.5-flash']
      )
    } finally {
      await prisma.$disconnect()
    }
    if (!payload) return c.json({ error: 'not_found' }, 404)

    const env = getEnv()
    const doId = env.CHAPTER_GEN.idFromName(`${id}:${chapterNumber}`)
    const stub = env.CHAPTER_GEN.get(doId)
    const result = await stub.start(payload)
    return c.json(result, 202)
  })

  // 生成中の章本文 SSE。DO に橋渡しするだけ。EventSource で接続すると自動再接続される。
  // 既に done/error なら最終イベントを送って閉じる。
  .get('/novels/:id/chapters/:number/stream', async (c) => {
    const id = c.req.param('id')
    const chapterNumber = Number.parseInt(c.req.param('number'), 10)
    if (Number.isNaN(chapterNumber) || chapterNumber < 1) {
      return c.json({ error: 'invalid_chapter_number' }, 400)
    }
    const env = getEnv()
    const doId = env.CHAPTER_GEN.idFromName(`${id}:${chapterNumber}`)
    const stub = env.CHAPTER_GEN.get(doId)
    return stub.openStream()
  })

  .post(
    '/novels/:id/generation/start',
    requireAuth,
    zValidator('json', z.object({ chapters: z.array(z.number().int().min(1)).min(1), model: GeminiModelSchema })),
    async (c) => {
      const id = c.req.param('id')
      const { chapters, model } = c.req.valid('json')
      const prisma = getPrisma()
      try {
        await upsertGenerationJob(prisma, id, {
          status: 'running',
          pending: JSON.stringify(chapters),
          current: chapters[0],
          model
        })
        const payload = await buildChapterPayload(prisma, id, chapters[0], model)
        if (!payload) return c.json({ error: 'not_found' }, 404)
        const env = getEnv()
        const doId = env.CHAPTER_GEN.idFromName(`${id}:${chapters[0]}`)
        const stub = env.CHAPTER_GEN.get(doId)
        await stub.start(payload)
        return c.json({ status: 'started' }, 202)
      } finally {
        await prisma.$disconnect()
      }
    }
  )

  .post('/novels/:id/generation/stop', requireAuth, async (c) => {
    const id = c.req.param('id')
    const prisma = getPrisma()
    try {
      await stopGenerationJob(prisma, id)
      return c.json({ ok: true })
    } finally {
      await prisma.$disconnect()
    }
  })

  // 章本文の削除。整合性を保つため「最新の生成済み章」しか消せない (後続を消さないと前章を消す意味がないので)。
  .delete('/novels/:id/chapters/:number', requireAuth, async (c) => {
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
  .post('/characters', requireAuth, zValidator('json', CreateCharacterSchema), async (c) => {
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
  .put('/characters/:id', requireAuth, zValidator('json', CreateCharacterSchema), async (c) => {
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
  .delete('/characters/:id', requireAuth, async (c) => {
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

  // ── Auth ──────────────────────────────────────────────────────────────
  // 認証状態を返すエンドポイント。匿名 (CF Access JWT なし) なら 200 + email=null、
  // 認証済なら 200 + email=user@example.com。401 ではなく常に 200 を返すのは、
  // フロントが「未認証か API ダウンか」を切り分けやすくするため。
  .get('/auth/me', async (c) => {
    const email = await readAuthEmail(c)
    return c.json({ email })
  })

export type AppType = typeof app
