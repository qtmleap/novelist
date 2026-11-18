import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { PrismaClient } from '@/generated/prisma/client'
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
import { type Env, getEnv, getPrisma } from '@/lib/db'
import {
  adultBibleIssues,
  type BibleEffects,
  bibleBlocker,
  bibleOutdated,
  createBibleFlow,
  currentBibleHash,
  generateOutlineFlow,
  normalizeBible,
  notesBlocker,
  type OutlineFlowInput,
  outlinePromptInput,
  prepareBibleFlow,
  regenerateOutlineChapters,
  toStoryBible
} from '@/lib/novel/assist'
import {
  buildCastForGemini,
  buildRelationsForGemini,
  type GenerationStart,
  jsonCaller,
  prepareGenerationStart,
  recordCostsBestEffort,
  revisionInstruction,
  viewpointCharFor
} from '@/lib/novel/chapter-context'
import { normalizeOutlineCharacters, sortOutline, validateThreads } from '@/lib/novel/outline'
import { buildOutlinePrompt, renderPromptForStorage } from '@/lib/novel/prompts'
import {
  arrangeNovels,
  chapterStaleness,
  createCategory,
  createNovel,
  deleteCategory,
  deleteNovel,
  getNovelWithChapters,
  getWrittenCharCounts,
  listCategories,
  listChapterVersions,
  listNovels,
  outlineStamps,
  renameCategory,
  reorderCategories,
  saveBible,
  saveNovelCast,
  saveOutlineWithStamps,
  stopGenerationJob,
  updateNovel,
  upsertGenerationJob
} from '@/lib/novel/repository'
import { buildModelCatalog } from '@/lib/openai/models'
import { type CharacterVariant, CharacterVariantInputSchema, CreateCharacterSchema } from '@/schemas/character.dto'
import {
  ArrangeNovelsSchema,
  CreateCategorySchema,
  CreateNovelSchema,
  FOCAL_POVS,
  GenerateChapterOptionsSchema,
  GenerateOptionsSchema,
  GenerateOutlineOptionsSchema,
  type ModelRef,
  ModelRefSchema,
  OutlineSchema,
  ReorderSchema,
  SaveCastSchema
} from '@/schemas/novel.dto'
import { StoryBibleSchema } from '@/schemas/story.dto'
import { readAuthEmail, requireAuth } from '@/server/auth'

// 本文生成でモデル指定が無かったときの既定。
const DEFAULT_CHAPTER_MODEL: ModelRef = 'gemini-2.5-flash'

type NovelWithChapters = NonNullable<Awaited<ReturnType<typeof getNovelWithChapters>>>

// 章立ての生成・書き直し・プレビューに渡す資料。
// alwaysInclude は語り手: 視点人物を指定できる視点 (一人称 / 三人称一元視点) で、視点人物が居るときだけ。
function outlineFlowInput(novel: NovelWithChapters): OutlineFlowInput {
  const viewpointChar = viewpointCharFor(novel.character_links, novel.pov_character_id)
  return {
    novel: {
      title: novel.title,
      genre: novel.genre,
      setting: novel.setting,
      num_chapters: novel.num_chapters,
      outline_summary_chars: novel.outline_summary_chars,
      notes: novel.notes
    },
    style: {
      pov: novel.pov,
      tone: novel.tone,
      age_rating: novel.age_rating,
      ending: novel.ending,
      viewpointChar
    },
    cast: buildCastForGemini(novel.character_links),
    relations: buildRelationsForGemini(novel.relations),
    alwaysInclude: viewpointChar !== undefined && FOCAL_POVS.includes(novel.pov) ? [viewpointChar.name] : [],
    bible: novel.bible === null ? null : toStoryBible(novel.bible),
    bibleUnreadable: novel.bible_unreadable
  }
}

// 章立ての生成とプレビューで、利用者の指示の欄 (執筆上の指示、備考) を理由に止める文。止めなければ null。
// 成人指定で、指示の欄に未成年を指す語があるとき (作品設計の有無に関係なく検査する)。
function outlineNotesBlocker(novel: NovelWithChapters, input: OutlineFlowInput): string | null {
  return notesBlocker({ style: input.style, writingNotes: novel.writing_notes, notes: novel.notes })
}

// 生成の開始を止めるときの応答の本文。
function startErrorBody(start: Exclude<GenerationStart, { ok: true }>): { error: string; detail?: string } {
  return start.status === 404 ? { error: start.error } : { error: start.error, detail: start.detail }
}

// 作品設計の保存先とコストの記録先 (kind: 'bible'、chapter_number 0)。
function bibleEffects(prisma: PrismaClient, env: Env, novelId: string): BibleEffects {
  return {
    save: (stored) => saveBible(prisma, novelId, stored),
    recordUsages: (usages) => recordCostsBestEffort(prisma, env, { novelId, chapterNumber: 0, kind: 'bible' }, usages)
  }
}

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
  writing_notes: string
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
    writing_notes: n.writing_notes,
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
      const charCounts = await getWrittenCharCounts(prisma)
      return c.json(
        novels.map((n) => {
          const written = charCounts.get(n.id)
          return { ...serializeNovel(n), written_chars: written === undefined ? 0 : written }
        })
      )
    } finally {
      await prisma.$disconnect()
    }
  })
  // 整理ページの配置保存 (カテゴリ移動 + 並び替え)。:id ルートより前に置く (static 優先だが念のため)。
  .put('/novels/arrangement', requireAuth, zValidator('json', ArrangeNovelsSchema), async (c) => {
    const input = c.req.valid('json')
    const prisma = getPrisma()
    try {
      await arrangeNovels(prisma, input.groups)
      return c.json({ ok: true })
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
  .put('/categories/reorder', requireAuth, zValidator('json', ReorderSchema), async (c) => {
    const input = c.req.valid('json')
    const prisma = getPrisma()
    try {
      const categories = await reorderCategories(prisma, input.ids)
      return c.json(categories.map((cat) => ({ id: cat.id, name: cat.name, novel_count: cat._count.novels })))
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
      // 作成直後は章本文なし。
      return c.json({ ...serializeNovel(novel), written_chars: 0 }, 201)
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
      // 各章の鮮度 (章立てが変わった、前の章が作り直された)。判定できない章 (この機能より前の章) は stale にならない。
      const staleness = chapterStaleness(novel.chapters, parseStoredOutline(novel.outline))
      return c.json({
        ...serializeNovel(novel),
        written_chars: novel.chapters.reduce((sum, ch) => sum + ch.content.length, 0),
        chapters: novel.chapters.map((ch) => ({
          id: ch.id,
          novel_id: ch.novel_id,
          chapter_number: ch.chapter_number,
          title: ch.title,
          content: ch.content,
          created_at: ch.created_at.toISOString(),
          record: ch.record,
          staleness: staleness.get(ch.chapter_number),
          review: ch.review
        })),
        cast: novel.cast,
        relations: novel.relations,
        generation_costs: novel.generation_costs,
        total_cost_usd: novel.total_cost_usd,
        aux_cost_usd: novel.aux_cost_usd,
        // 作品設計 (source_hash は出さない) と、作成後に入力が変わったか
        bible: novel.bible === null ? null : toStoryBible(novel.bible),
        // 保存値が読めない作品設計も、作り直すか確かめてもらうために true にする (bible は null のまま返す)
        bible_outdated: novel.bible_unreadable || bibleOutdated(novel.bible, outlineFlowInput(novel)),
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
      // 更新は章本文を変えないので、表示用の written_chars は一覧/詳細の再取得で確定させる。
      return c.json({ ...serializeNovel(novel), written_chars: 0 })
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
  // 小説のキャスト・関係・語り手を専用ページからまとめて保存。
  .put('/novels/:id/cast', requireAuth, zValidator('json', SaveCastSchema), async (c) => {
    const id = c.req.param('id')
    const input = c.req.valid('json')
    const prisma = getPrisma()
    try {
      await saveNovelCast(prisma, id, input)
      return c.json({ ok: true })
    } finally {
      await prisma.$disconnect()
    }
  })

  // 作品設計を作り直して保存する。章立てや本文は作り直さない (消しもしない)。
  // 失敗 (成人指定の条件を満たさない場合を含む) は 502。detail に理由。
  .post('/novels/:id/bible', requireAuth, zValidator('json', GenerateOptionsSchema), async (c) => {
    const id = c.req.param('id')
    const options = c.req.valid('json')
    const prisma = getPrisma()
    try {
      const novel = await getNovelWithChapters(prisma, id)
      if (!novel) return c.json({ error: 'not_found' }, 404)
      const env = getEnv()
      const model = options.model !== undefined ? options.model : novel.editor_model
      const result = await createBibleFlow(
        jsonCaller(env, model),
        outlineFlowInput(novel),
        bibleEffects(prisma, env, id)
      )
      if (!result.ok) return c.json({ error: 'generation_failed', detail: result.error }, 502)
      return c.json({ bible: result.bible })
    } finally {
      await prisma.$disconnect()
    }
  })

  // 作品設計の手動の保存。呼称表は名簿と関係に照らして整え、全年齢では人物設定を持たない (生成と同じ整え方)。
  // 成人指定で人物設定が条件を満たさなければ 400 invalid_bible (detail に理由)。
  // 保存時のハッシュは今の入力のもの (手で直した時点の入力に合わせた、とみなす)。
  .put('/novels/:id/bible', requireAuth, zValidator('json', z.object({ bible: StoryBibleSchema })), async (c) => {
    const id = c.req.param('id')
    const body = c.req.valid('json')
    const prisma = getPrisma()
    try {
      const novel = await getNovelWithChapters(prisma, id)
      if (!novel) return c.json({ error: 'not_found' }, 404)
      const input = outlineFlowInput(novel)
      const bible = normalizeBible(body.bible, input)
      const issues = adultBibleIssues(bible, input)
      if (issues.length > 0) return c.json({ error: 'invalid_bible', detail: issues.join('、') }, 400)
      await saveBible(prisma, id, { ...bible, source_hash: currentBibleHash(input) })
      return c.json({ bible })
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
      const input = outlineFlowInput(novel)
      const call = jsonCaller(env, options.model)

      // 既存 outline がある + chapters[] 指定 (かつ全章ではない) → 部分再生成。
      // それ以外 (= 初回 / 指定なし / 全章指定) → 全章まとめて生成 (Worker のタイムアウト回避)。
      // 同じ章を 2 回書き直さないよう、重複を除いて番号順にする。
      const existing = parseStoredOutline(novel.outline)
      const targets = [...new Set(options.chapters.filter((n) => n >= 1 && n <= novel.num_chapters))].sort(
        (a, b) => a - b
      )
      const partial = targets.length > 0 && targets.length < novel.num_chapters
      const generated = novel.outline !== null && novel.outline.length > 0

      // 章を選んだ書き直しなのに、保存済みの章立てが解釈できない。全章の生成に切り替えると
      // 選んでいない章まで作り直し、全本文を消してしまうので、何もせずエラーにする (POST /outline/:number と同じ扱い)。
      if (partial && generated && existing === null) return c.json({ error: 'invalid_outline' }, 500)

      // 指示の欄で止めるなら、作品設計を作る (費用がかかる) より前に止める。
      const notes = outlineNotesBlocker(novel, input)
      if (notes !== null) return c.json({ error: 'invalid_notes', detail: notes }, 400)

      // 作品設計が無ければ先に作る (章立ては作品設計を入力に取る)。モデルは章立てと同じ (指定が無ければ editor_model)。
      const bible = await prepareBibleFlow(
        jsonCaller(env, options.model !== undefined ? options.model : novel.editor_model),
        input,
        bibleEffects(prisma, env, id)
      )
      if (!bible.ok) return c.json({ error: bible.error, detail: bible.detail }, bible.status)
      const planned: OutlineFlowInput = { ...input, bible: bible.bible }

      if (partial && existing !== null) {
        // 既存の outline を保持しつつ、選択された章だけ生成し直してマージする。
        // 後の章で失敗しても、それまでに払った分は残るよう章ごとにすぐ記録する。
        const result = await regenerateOutlineChapters(call, planned, existing, targets, (n, usages) =>
          recordCostsBestEffort(prisma, env, { novelId: id, chapterNumber: n, kind: 'outline' }, usages)
        )
        if (!result.ok) return c.json({ error: 'generation_failed', detail: result.error }, 502)
        // 本文は消さない。章立てが変わった章は鮮度の判定で「要再生成」になる。
        await saveOutlineWithStamps(prisma, id, JSON.stringify(result.outline), outlineStamps(novel.chapters, existing))
        return c.json({ outline: result.outline, warnings: result.warnings })
      }

      // 全章まとめて生成。本文は消さない (章立てが変わった章は「要再生成」になる)。
      // 失敗した回もトークンは課金されているので、成否にかかわらず記録する。
      const result = await generateOutlineFlow(call, planned)
      await recordCostsBestEffort(prisma, env, { novelId: id, chapterNumber: 0, kind: 'outline' }, result.usages)
      if (!result.ok) return c.json({ error: 'generation_failed', detail: result.error }, 502)
      const outline = sortOutline(result.outline)
      await saveOutlineWithStamps(prisma, id, JSON.stringify(outline), outlineStamps(novel.chapters, existing))
      return c.json({ outline, warnings: result.warnings })
    } finally {
      await prisma.$disconnect()
    }
  })

  // 章立ての手動編集。AI 生成ではなくユーザーが直接 title/summary/characters を書き換える経路。
  // 既存章本文には触らない (本文と outline がズレた場合は別途章本文を再生成する想定)。
  // 登場人物は名簿の正式名に揃え、照合できない名前は外して警告で返す。
  // 語り手は足さない (利用者が外した人物を勝手に戻さないため)。
  .put('/novels/:id/outline', requireAuth, zValidator('json', z.object({ outline: OutlineSchema })), async (c) => {
    const id = c.req.param('id')
    const { outline } = c.req.valid('json')
    const prisma = getPrisma()
    try {
      const novel = await getNovelWithChapters(prisma, id)
      if (!novel) return c.json({ error: 'not_found' }, 404)
      const castNames = buildCastForGemini(novel.character_links).map((member) => member.name)
      // 名簿が無い作品では characters をそのまま残す (normalizeOutlineCharacters は全章で空にするため)。
      const normalized =
        castNames.length > 0 ? normalizeOutlineCharacters(outline, castNames) : { outline, warnings: [] }
      // 伏線は検証・修復して保存する (回収の id が前の章の伏線に無ければ外す、など)。
      const threads = validateThreads(sortOutline(normalized.outline))
      // 手で直した章も、生成と同じく鮮度の判定に乗せる (この機能より前の章に、変更前の章立てのハッシュを書く)。
      await saveOutlineWithStamps(
        prisma,
        id,
        JSON.stringify(threads.outline),
        outlineStamps(novel.chapters, parseStoredOutline(novel.outline))
      )
      return c.json({ outline: threads.outline, warnings: [...normalized.warnings, ...threads.warnings] })
    } finally {
      await prisma.$disconnect()
    }
  })

  // 章立て生成プロンプトのプレビュー (LLM に投げる前の文字列を返す。デバッグ用)
  .get('/novels/:id/outline/preview', async (c) => {
    const id = c.req.param('id')
    const prisma = getPrisma()
    try {
      const novel = await getNovelWithChapters(prisma, id)
      if (!novel) return c.json({ error: 'not_found' }, 404)
      // 保存済みの作品設計があれば入れる (無ければ、生成時に先に作られる)。
      // 成人指定で作品設計が検証に落ちる・読めないときは、その人物設定を含むプロンプトを組み立てて返さない。
      const input = outlineFlowInput(novel)
      const blocked = bibleBlocker(input)
      if (blocked !== null) return c.json({ error: 'invalid_bible', detail: blocked }, 400)
      const notes = outlineNotesBlocker(novel, input)
      if (notes !== null) return c.json({ error: 'invalid_notes', detail: notes }, 400)
      const prompt = renderPromptForStorage(buildOutlinePrompt(outlinePromptInput(input)))
      return c.json({ prompt })
    } finally {
      await prisma.$disconnect()
    }
  })

  // 章本文生成時に実際に Gemini へ送ったプロンプト (最新 version) を返す。
  // この機能より前に生成された章は prompt=null。
  .get('/novels/:id/chapters/:number/prompt', zValidator('param', ChapterParamSchema), async (c) => {
    const { id, number: chapterNumber } = c.req.valid('param')
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
  // 章の生成履歴 (全 version)。再生成しても過去は append-only で残るので、ここで全部返す。
  .get('/novels/:id/chapters/:number/versions', zValidator('param', ChapterParamSchema), async (c) => {
    const { id, number: chapterNumber } = c.req.valid('param')
    const prisma = getPrisma()
    try {
      const versions = await listChapterVersions(prisma, id, chapterNumber)
      return c.json(
        versions.map((v) => ({
          id: v.id,
          version: v.version,
          title: v.title,
          content: v.content,
          prompt: v.prompt,
          created_at: v.created_at.toISOString(),
          record: v.record,
          review: v.review
        }))
      )
    } finally {
      await prisma.$disconnect()
    }
  })

  .post(
    '/novels/:id/outline/:number',
    requireAuth,
    zValidator('param', ChapterParamSchema),
    zValidator('json', GenerateOptionsSchema),
    async (c) => {
      const { id, number: chapterNumber } = c.req.valid('param')
      const options = c.req.valid('json')
      const prisma = getPrisma()
      try {
        const novel = await getNovelWithChapters(prisma, id)
        if (!novel) return c.json({ error: 'not_found' }, 404)
        if (!novel.outline) return c.json({ error: 'outline_not_generated' }, 400)
        // 章数を超える章を足すと、章立ての章数が作品の章数と合わなくなる。
        if (chapterNumber > novel.num_chapters) return c.json({ error: 'chapter_out_of_range' }, 400)

        const parsedOutline = OutlineSchema.safeParse(JSON.parse(novel.outline))
        if (!parsedOutline.success) return c.json({ error: 'invalid_outline' }, 500)

        const env = getEnv()
        const input = outlineFlowInput(novel)
        const notes = outlineNotesBlocker(novel, input)
        if (notes !== null) return c.json({ error: 'invalid_notes', detail: notes }, 400)
        const bible = await prepareBibleFlow(
          jsonCaller(env, options.model !== undefined ? options.model : novel.editor_model),
          input,
          bibleEffects(prisma, env, id)
        )
        if (!bible.ok) return c.json({ error: bible.error, detail: bible.detail }, bible.status)
        const result = await regenerateOutlineChapters(
          jsonCaller(env, options.model),
          { ...input, bible: bible.bible },
          parsedOutline.data,
          [chapterNumber],
          (n, usages) => recordCostsBestEffort(prisma, env, { novelId: id, chapterNumber: n, kind: 'outline' }, usages)
        )
        if (!result.ok) return c.json({ error: 'generation_failed', detail: result.error }, 502)
        // 本文は消さない。章立てが変わった章は鮮度の判定で「要再生成」になる。
        await saveOutlineWithStamps(
          prisma,
          id,
          JSON.stringify(result.outline),
          outlineStamps(novel.chapters, parsedOutline.data)
        )
        return c.json({ outline: result.outline, warnings: result.warnings })
      } finally {
        await prisma.$disconnect()
      }
    }
  )

  // 生成キックオフ。Durable Object に payload を渡して即座に 202 を返す。
  // 生成自体は DO 内で fire-and-forget で走り続け、ページ離脱・タブ閉じでも止まらない。
  // クライアントは下の /stream エンドポイントで SSE 経由で進捗を受け取る。
  .post(
    '/novels/:id/chapters/:number/generate',
    requireAuth,
    zValidator('param', ChapterParamSchema),
    zValidator('json', GenerateChapterOptionsSchema),
    async (c) => {
      const { id, number: chapterNumber } = c.req.valid('param')
      const options = c.req.valid('json')
      const prisma = getPrisma()
      // instruction が空でなければ、指示つきの書き直し (base_version_id の版、空ならその章の最新の版を元にする)。
      // 書き直しでも、通常の生成と同じ検証を通す。元の版の確認は DO の文脈の段階で行う。
      // 小説と章立ての該当章があること、作品設計が成人指定の条件を満たすこと、前の章が欠けていないことを確かめる。
      // 文脈 (既出の章、確定事項) は DO が組み立てる (DO も同じ作品設計の判定をする)。
      const model = options.model !== undefined ? options.model : DEFAULT_CHAPTER_MODEL
      // 書き直しの指示も、成人指定なら開始の時点で検査する (400 invalid_instruction)。
      // 書き直しなら、元の版がこの小説のこの章のもので本文があることも確かめる (400 invalid_base_version)。
      const start = await prepareGenerationStart(prisma, id, [chapterNumber], model, {
        instruction: options.instruction,
        baseVersionId: options.base_version_id
      }).finally(() => prisma.$disconnect())
      if (!start.ok) return c.json(startErrorBody(start), start.status)
      const payload =
        revisionInstruction(options.instruction).length > 0
          ? { ...start.payload, instruction: options.instruction, baseVersionId: options.base_version_id }
          : start.payload

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

  .post(
    '/novels/:id/generation/start',
    requireAuth,
    zValidator('json', z.object({ chapters: z.array(z.number().int().min(1)).min(1), model: ModelRefSchema })),
    async (c) => {
      const id = c.req.param('id')
      const { chapters, model } = c.req.valid('json')
      const prisma = getPrisma()
      try {
        // 前から順に書く。対象は重複を除いて昇順にする。小説と章立ての最初の章 (404)、作品設計 (400 invalid_bible)、
        // 前の章の欠け (409) を確かめてからジョブを running にする (止めたときに running のジョブを残さない)。
        const start = await prepareGenerationStart(prisma, id, chapters, model)
        if (!start.ok) return c.json(startErrorBody(start), start.status)
        const first = start.payload.chapterNumber
        await upsertGenerationJob(prisma, id, {
          status: 'running',
          pending: JSON.stringify(start.targets),
          current: first,
          model
        })
        const payload = start.payload
        const env = getEnv()
        const doId = env.CHAPTER_GEN.idFromName(`${id}:${first}`)
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
  .delete('/novels/:id/chapters/:number', requireAuth, zValidator('param', ChapterParamSchema), async (c) => {
    const { id, number: chapterNumber } = c.req.valid('param')
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

  // ── Character variants (別の姿・状態。専用ページから管理) ──────────────
  .post('/characters/:id/variants', requireAuth, zValidator('json', CharacterVariantInputSchema), async (c) => {
    const id = c.req.param('id')
    const input = c.req.valid('json')
    const prisma = getPrisma()
    try {
      const variant = await createVariant(prisma, id, input)
      return c.json(variant, 201)
    } finally {
      await prisma.$disconnect()
    }
  })
  .put(
    '/characters/:id/variants/:variantId',
    requireAuth,
    zValidator('json', CharacterVariantInputSchema),
    async (c) => {
      const id = c.req.param('id')
      const variantId = c.req.param('variantId')
      const input = c.req.valid('json')
      const prisma = getPrisma()
      try {
        const variant = await updateVariant(prisma, id, variantId, input)
        if (variant === null) return c.json({ error: 'not_found' }, 404)
        return c.json(variant)
      } finally {
        await prisma.$disconnect()
      }
    }
  )
  .delete('/characters/:id/variants/:variantId', requireAuth, async (c) => {
    const id = c.req.param('id')
    const variantId = c.req.param('variantId')
    const prisma = getPrisma()
    try {
      await deleteVariant(prisma, id, variantId)
      return c.body(null, 204)
    } finally {
      await prisma.$disconnect()
    }
  })

  // ── Models ────────────────────────────────────────────────────────────
  // モデル選択に出す一覧。Gemini は固定表、OpenAI 互換はサーバーの /models をそのまま返す。
  // URL と API キーは返さず、設定済みかどうかだけを返す。認証は不要 (一覧と単価だけで秘密を含まない)。
  .get('/models', async (c) => {
    return c.json(await buildModelCatalog(getEnv()))
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
