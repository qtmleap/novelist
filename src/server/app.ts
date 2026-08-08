import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  createCharacter,
  createVariant,
  deleteCharacter,
  deleteVariant,
  getCharacter,
  listCharacters,
  updateCharacter,
  updateVariant
} from '@/lib/character/repository'
import { getEnv, isPrismaNotFound, withPrisma } from '@/lib/db'
import { buildOutlinePrompt, generateOutline, regenerateOutlineChapter } from '@/lib/gemini/client'
import { buildChapterPayload, buildPromptInputs } from '@/lib/novel/chapter-payload'
import {
  arrangeNovels,
  createCategory,
  createNovel,
  deleteCategory,
  deleteNovel,
  getNovelWithChapters,
  getWrittenCharCounts,
  listCategories,
  listChapterVersions,
  listNovels,
  renameCategory,
  reorderCategories,
  saveNovelCast,
  saveOutline,
  stopGenerationJob,
  updateNovel,
  upsertGenerationJob
} from '@/lib/novel/repository'
import { type CharacterVariant, CharacterVariantInputSchema, CreateCharacterSchema } from '@/schemas/character.dto'
import {
  ArrangeNovelsSchema,
  CreateCategorySchema,
  CreateNovelSchema,
  DEFAULT_GENERATION_MODEL,
  GenerateOptionsSchema,
  GenerateOutlineOptionsSchema,
  OutlineSchema,
  ReorderSchema,
  SaveCastSchema,
  StartBatchGenerationSchema,
  UpdateOutlineBodySchema
} from '@/schemas/novel.dto'
import { readAuthEmail, requireAuth } from '@/server/auth'

// 章番号を含むルートの param。z.coerce で文字列 → 数値に変換・検証するので
// ハンドラ側で Number.parseInt や NaN チェックを書かなくてよい (不正なら zValidator が 400)。
const ChapterParamSchema = z.object({
  id: z.string().min(1),
  number: z.coerce.number().int().min(1)
})

function serializeNovel(n: {
  id: string
  title: string
  genre: string
  setting: string
  num_chapters: number
  target_chars: number
  outline_summary_chars: number
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
    setting: n.setting,
    num_chapters: n.num_chapters,
    target_chars: n.target_chars,
    outline_summary_chars: n.outline_summary_chars,
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
  variants: CharacterVariant[]
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
    variants: c.variants,
    created_at: c.created_at.toISOString(),
    updated_at: c.updated_at.toISOString()
  }
}

// カテゴリ一覧の JSON 化。`_count.novels` → `novel_count` に整形して返す 3 箇所の重複を集約。
function serializeCategory(cat: { id: string; name: string; _count: { novels: number } }) {
  return { id: cat.id, name: cat.name, novel_count: cat._count.novels }
}

// generation_job.pending は JSON 文字列で number[] を持つ。壊れていれば空配列扱いで表面化させる。
function parsePendingChapters(raw: string): number[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter((x): x is number => typeof x === 'number')
}

// NOTE: すべてのルートを 1 本のビルダーにチェーンしているのは、`typeof app` に
// 各エンドポイントの入出力スキーマを乗せるため。将来 hc<AppType> 相当のクライアントを
// 導入する場合に備えており、`app.get(...)` を代入し直すと型推論を失う。
export const app = new Hono()
  .basePath('/api')

  // ── Novels ────────────────────────────────────────────────────────────
  .get('/novels', (c) =>
    withPrisma(async (prisma) => {
      const novels = await listNovels(prisma)
      const charCounts = await getWrittenCharCounts(prisma)
      return c.json(
        novels.map((n) => {
          const written = charCounts.get(n.id)
          return { ...serializeNovel(n), written_chars: written === undefined ? 0 : written }
        })
      )
    })
  )
  // 整理ページの配置保存 (カテゴリ移動 + 並び替え)。:id ルートより前に置く (static 優先だが念のため)。
  .put('/novels/arrangement', requireAuth, zValidator('json', ArrangeNovelsSchema), (c) =>
    withPrisma(async (prisma) => {
      const input = c.req.valid('json')
      await arrangeNovels(prisma, input.groups)
      return c.json({ ok: true })
    })
  )

  // ── Categories (ユーザー作成のフォルダ式カテゴリ) ──────────────────────
  .get('/categories', (c) =>
    withPrisma(async (prisma) => {
      const categories = await listCategories(prisma)
      return c.json(categories.map(serializeCategory))
    })
  )
  .post('/categories', requireAuth, zValidator('json', CreateCategorySchema), (c) =>
    withPrisma(async (prisma) => {
      const input = c.req.valid('json')
      const category = await createCategory(prisma, input.name)
      return c.json({ id: category.id, name: category.name, novel_count: 0 }, 201)
    })
  )
  .put('/categories/reorder', requireAuth, zValidator('json', ReorderSchema), (c) =>
    withPrisma(async (prisma) => {
      const input = c.req.valid('json')
      const categories = await reorderCategories(prisma, input.ids)
      return c.json(categories.map(serializeCategory))
    })
  )
  .put('/categories/:id', requireAuth, zValidator('json', CreateCategorySchema), (c) =>
    withPrisma(async (prisma) => {
      const id = c.req.param('id')
      const input = c.req.valid('json')
      const result = await renameCategory(prisma, id, input.name)
      if (result.status === 'name_taken') return c.json({ error: 'name_taken' }, 409)
      if (result.status === 'not_found') return c.json({ error: 'not_found' }, 404)
      return c.json(result.category)
    })
  )
  .delete('/categories/:id', requireAuth, (c) =>
    withPrisma(async (prisma) => {
      const id = c.req.param('id')
      await deleteCategory(prisma, id)
      return c.json({ id })
    })
  )

  .post('/novels', requireAuth, zValidator('json', CreateNovelSchema), (c) =>
    withPrisma(async (prisma) => {
      const input = c.req.valid('json')
      const novel = await createNovel(prisma, input)
      // 作成直後は章本文なし。
      return c.json({ ...serializeNovel(novel), written_chars: 0 }, 201)
    })
  )

  .get('/novels/:id', (c) =>
    withPrisma(async (prisma) => {
      const id = c.req.param('id')
      const novel = await getNovelWithChapters(prisma, id)
      if (!novel) return c.json({ error: 'not_found' }, 404)
      const genJob = novel.generation_job
        ? {
            status: novel.generation_job.status,
            current: novel.generation_job.current,
            pending: parsePendingChapters(novel.generation_job.pending)
          }
        : null
      return c.json({
        ...serializeNovel(novel),
        written_chars: novel.chapters.reduce((sum, ch) => sum + ch.content.length, 0),
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
        gen_job: genJob
      })
    })
  )
  .put('/novels/:id', requireAuth, zValidator('json', CreateNovelSchema), (c) =>
    withPrisma(async (prisma) => {
      const id = c.req.param('id')
      const input = c.req.valid('json')
      try {
        const existing = await prisma.novel.findUnique({ where: { id }, select: { num_chapters: true } })
        if (!existing) return c.json({ error: 'not_found' }, 404)
        // 章数を減らすと既存章本文が宙ぶらりんになるので拒否。増やすのは OK。
        if (input.num_chapters < existing.num_chapters) {
          return c.json({ error: 'num_chapters_cannot_decrease', current: existing.num_chapters }, 409)
        }
        const novel = await updateNovel(prisma, id, input)
        // 更新は章本文を変えないので、表示用の written_chars は一覧/詳細の再取得で確定させる。
        return c.json({ ...serializeNovel(novel), written_chars: 0 })
      } catch (e) {
        if (isPrismaNotFound(e)) return c.json({ error: 'not_found' }, 404)
        throw e
      }
    })
  )
  .delete('/novels/:id', requireAuth, (c) =>
    withPrisma(async (prisma) => {
      const id = c.req.param('id')
      try {
        await deleteNovel(prisma, id)
        return c.body(null, 204)
      } catch (e) {
        if (isPrismaNotFound(e)) return c.json({ error: 'not_found' }, 404)
        throw e
      }
    })
  )
  // 小説のキャスト・関係・語り手を専用ページからまとめて保存。
  .put('/novels/:id/cast', requireAuth, zValidator('json', SaveCastSchema), (c) =>
    withPrisma(async (prisma) => {
      const id = c.req.param('id')
      const input = c.req.valid('json')
      await saveNovelCast(prisma, id, input)
      return c.json({ ok: true })
    })
  )

  .post('/novels/:id/outline', requireAuth, zValidator('json', GenerateOutlineOptionsSchema), (c) =>
    withPrisma(async (prisma) => {
      const id = c.req.param('id')
      const options = c.req.valid('json')
      const novel = await getNovelWithChapters(prisma, id)
      if (!novel) return c.json({ error: 'not_found' }, 404)

      const env = getEnv()
      const { params, style, cast, relations } = buildPromptInputs(novel)

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
    })
  )

  // 章立ての手動編集。AI 生成ではなくユーザーが直接 title/summary を書き換える経路。
  // 既存章本文には触らない (本文と outline がズレた場合は別途章本文を再生成する想定)。
  .put('/novels/:id/outline', requireAuth, zValidator('json', UpdateOutlineBodySchema), (c) =>
    withPrisma(async (prisma) => {
      const id = c.req.param('id')
      const { outline } = c.req.valid('json')
      const existing = await prisma.novel.findUnique({ where: { id }, select: { id: true } })
      if (!existing) return c.json({ error: 'not_found' }, 404)
      await saveOutline(prisma, id, JSON.stringify(outline))
      return c.json({ outline })
    })
  )

  // 章立て生成プロンプトのプレビュー (Gemini に投げる前の文字列を返す。デバッグ用)
  .get('/novels/:id/outline/preview', (c) =>
    withPrisma(async (prisma) => {
      const id = c.req.param('id')
      const novel = await getNovelWithChapters(prisma, id)
      if (!novel) return c.json({ error: 'not_found' }, 404)
      const { params, style, cast, relations } = buildPromptInputs(novel)
      const prompt = buildOutlinePrompt(params, style, cast, relations)
      return c.json({ prompt })
    })
  )

  // 章本文生成時に実際に Gemini へ送ったプロンプト (最新 version) を返す。
  // この機能より前に生成された章は prompt=null。
  .get('/novels/:id/chapters/:number/prompt', zValidator('param', ChapterParamSchema), (c) =>
    withPrisma(async (prisma) => {
      const { id, number: chapterNumber } = c.req.valid('param')
      const chapter = await prisma.chapter.findFirst({
        where: { novel_id: id, chapter_number: chapterNumber },
        orderBy: { version: 'desc' },
        select: { prompt: true }
      })
      if (!chapter) return c.json({ error: 'not_found' }, 404)
      return c.json({ prompt: chapter.prompt })
    })
  )
  // 章の生成履歴 (全 version)。再生成しても過去は append-only で残るので、ここで全部返す。
  .get('/novels/:id/chapters/:number/versions', zValidator('param', ChapterParamSchema), (c) =>
    withPrisma(async (prisma) => {
      const { id, number: chapterNumber } = c.req.valid('param')
      const versions = await listChapterVersions(prisma, id, chapterNumber)
      return c.json(
        versions.map((v) => ({
          id: v.id,
          version: v.version,
          title: v.title,
          content: v.content,
          prompt: v.prompt,
          created_at: v.created_at.toISOString()
        }))
      )
    })
  )

  .post(
    '/novels/:id/outline/:number',
    requireAuth,
    zValidator('param', ChapterParamSchema),
    zValidator('json', GenerateOptionsSchema),
    (c) =>
      withPrisma(async (prisma) => {
        const { id, number: chapterNumber } = c.req.valid('param')
        const options = c.req.valid('json')
        const novel = await getNovelWithChapters(prisma, id)
        if (!novel) return c.json({ error: 'not_found' }, 404)
        if (!novel.outline) return c.json({ error: 'outline_not_generated' }, 400)

        const parsedOutline = OutlineSchema.safeParse(JSON.parse(novel.outline))
        if (!parsedOutline.success) return c.json({ error: 'invalid_outline' }, 500)

        const env = getEnv()
        const { params, style, cast, relations } = buildPromptInputs(novel)

        try {
          const next = await regenerateOutlineChapter(
            env,
            params,
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
      })
  )

  // 生成キックオフ。Durable Object に payload を渡して即座に 202 を返す。
  // 生成自体は DO 内で fire-and-forget で走り続け、ページ離脱・タブ閉じでも止まらない。
  // クライアントは下の /stream エンドポイントで SSE 経由で進捗を受け取る。
  .post(
    '/novels/:id/chapters/:number/generate',
    requireAuth,
    zValidator('param', ChapterParamSchema),
    zValidator('json', GenerateOptionsSchema),
    async (c) => {
      const { id, number: chapterNumber } = c.req.valid('param')
      const options = c.req.valid('json')
      const model = options.model !== undefined ? options.model : DEFAULT_GENERATION_MODEL
      const payload = await withPrisma((prisma) => buildChapterPayload(prisma, id, chapterNumber, model))
      if (!payload) return c.json({ error: 'not_found' }, 404)

      const env = getEnv()
      const doId = env.CHAPTER_GEN.idFromName(`${id}:${chapterNumber}`)
      const stub = env.CHAPTER_GEN.get(doId)
      const result = await stub.start(payload)
      return c.json(result, 202)
    }
  )

  // 生成中の章本文 SSE。DO に橋渡しするだけ。EventSource で接続すると自動再接続される。
  // 既に done/error なら最終イベントを送って閉じる。
  .get('/novels/:id/chapters/:number/stream', zValidator('param', ChapterParamSchema), async (c) => {
    const { id, number: chapterNumber } = c.req.valid('param')
    const env = getEnv()
    const doId = env.CHAPTER_GEN.idFromName(`${id}:${chapterNumber}`)
    const stub = env.CHAPTER_GEN.get(doId)
    return stub.openStream()
  })

  .post('/novels/:id/generation/start', requireAuth, zValidator('json', StartBatchGenerationSchema), (c) =>
    withPrisma(async (prisma) => {
      const id = c.req.param('id')
      const { chapters, model } = c.req.valid('json')
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
    })
  )

  .post('/novels/:id/generation/stop', requireAuth, (c) =>
    withPrisma(async (prisma) => {
      const id = c.req.param('id')
      await stopGenerationJob(prisma, id)
      return c.json({ ok: true })
    })
  )

  // 章本文の削除。整合性を保つため「最新の生成済み章」しか消せない (後続を消さないと前章を消す意味がないので)。
  .delete('/novels/:id/chapters/:number', requireAuth, zValidator('param', ChapterParamSchema), (c) =>
    withPrisma(async (prisma) => {
      const { id, number: chapterNumber } = c.req.valid('param')
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
    })
  )

  // ── Characters ───────────────────────────────────────────────────────
  .get('/characters', (c) =>
    withPrisma(async (prisma) => {
      const characters = await listCharacters(prisma)
      return c.json(characters.map(serializeCharacter))
    })
  )
  .post('/characters', requireAuth, zValidator('json', CreateCharacterSchema), (c) =>
    withPrisma(async (prisma) => {
      const input = c.req.valid('json')
      const character = await createCharacter(prisma, input)
      return c.json(serializeCharacter(character), 201)
    })
  )

  .get('/characters/:id', (c) =>
    withPrisma(async (prisma) => {
      const id = c.req.param('id')
      const character = await getCharacter(prisma, id)
      if (!character) return c.json({ error: 'not_found' }, 404)
      return c.json(serializeCharacter(character))
    })
  )
  .put('/characters/:id', requireAuth, zValidator('json', CreateCharacterSchema), (c) =>
    withPrisma(async (prisma) => {
      const id = c.req.param('id')
      const input = c.req.valid('json')
      try {
        const character = await updateCharacter(prisma, id, input)
        return c.json(serializeCharacter(character))
      } catch (e) {
        if (isPrismaNotFound(e)) return c.json({ error: 'not_found' }, 404)
        throw e
      }
    })
  )
  .delete('/characters/:id', requireAuth, (c) =>
    withPrisma(async (prisma) => {
      const id = c.req.param('id')
      try {
        await deleteCharacter(prisma, id)
        return c.body(null, 204)
      } catch (e) {
        if (isPrismaNotFound(e)) return c.json({ error: 'not_found' }, 404)
        throw e
      }
    })
  )

  // ── Character variants (別の姿・状態。専用ページから管理) ──────────────
  .post('/characters/:id/variants', requireAuth, zValidator('json', CharacterVariantInputSchema), (c) =>
    withPrisma(async (prisma) => {
      const id = c.req.param('id')
      const input = c.req.valid('json')
      const variant = await createVariant(prisma, id, input)
      return c.json(variant, 201)
    })
  )
  .put('/characters/:id/variants/:variantId', requireAuth, zValidator('json', CharacterVariantInputSchema), (c) =>
    withPrisma(async (prisma) => {
      const id = c.req.param('id')
      const variantId = c.req.param('variantId')
      const input = c.req.valid('json')
      const variant = await updateVariant(prisma, id, variantId, input)
      if (variant === null) return c.json({ error: 'not_found' }, 404)
      return c.json(variant)
    })
  )
  .delete('/characters/:id/variants/:variantId', requireAuth, (c) =>
    withPrisma(async (prisma) => {
      const id = c.req.param('id')
      const variantId = c.req.param('variantId')
      await deleteVariant(prisma, id, variantId)
      return c.body(null, 204)
    })
  )

  // ── Auth ──────────────────────────────────────────────────────────────
  // 認証状態を返すエンドポイント。匿名 (CF Access JWT なし) なら 200 + email=null、
  // 認証済なら 200 + email=user@example.com。401 ではなく常に 200 を返すのは、
  // フロントが「未認証か API ダウンか」を切り分けやすくするため。
  .get('/auth/me', async (c) => {
    const email = await readAuthEmail(c)
    return c.json({ email })
  })
