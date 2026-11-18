import type { Prisma, PrismaClient } from '@/generated/prisma/client'
import { computeStaleness, outlineEntryHash } from '@/lib/novel/staleness'
import {
  type CreateNovelInput,
  type Outline,
  type SaveCastInput,
  type StoredBible,
  StoredBibleSchema
} from '@/schemas/novel.dto'
import { type ChapterRecord, ChapterRecordSchema, type ChapterStaleness } from '@/schemas/story.dto'

// Novel.writing_notes は null 許容の列 (理由は schema.prisma の注記)。読むときはここで '' にそろえる。
function withWritingNotes<T extends { writing_notes: string | null }>(row: T): T & { writing_notes: string } {
  return { ...row, writing_notes: row.writing_notes === null ? '' : row.writing_notes }
}

// Novel.bible (JSON 文字列 | null) を検証して返す。未作成 (null) や壊れた値は null。
export function parseStoredBible(raw: string | null): StoredBible | null {
  if (raw === null || raw.length === 0) return null
  try {
    const result = StoredBibleSchema.safeParse(JSON.parse(raw))
    return result.success ? result.data : null
  } catch {
    return null
  }
}

// Chapter.record (JSON 文字列 | null) を検証して返す。未抽出 (null) や壊れた値は null。
// 壊れた記録を後の章の【確定事項】に混ぜないため、ここで弾く。
export function parseStoredRecord(raw: string | null): ChapterRecord | null {
  if (raw === null || raw.length === 0) return null
  try {
    const result = ChapterRecordSchema.safeParse(JSON.parse(raw))
    return result.success ? result.data : null
  } catch {
    return null
  }
}

// キャスト・関係・語り手は専用ページ (saveNovelCast) で管理するので本体作成では触らない。
export async function createNovel(prisma: PrismaClient, input: CreateNovelInput) {
  const created = await prisma.novel.create({
    data: {
      title: input.title,
      genre: input.genre,
      setting: input.setting,
      num_chapters: input.num_chapters,
      target_chars: input.target_chars,
      outline_summary_chars: input.outline_summary_chars,
      pov: input.pov,
      tone: input.tone,
      age_rating: input.age_rating,
      ending: input.ending,
      notes: input.notes,
      writing_notes: input.writing_notes,
      editor_model: input.editor_model,
      writer_model: input.writer_model,
      category_id: input.category_id
    },
    include: { category: { select: { name: true } } }
  })
  return withWritingNotes(created)
}

// 小説のキャスト (character_links) + 関係 + 語り手をまとめて置き換える。
// D1 はインタラクティブトランザクション非対応なので $transaction([...]) で順序実行。
export async function saveNovelCast(prisma: PrismaClient, id: string, input: SaveCastInput) {
  const ops: Prisma.PrismaPromise<unknown>[] = [
    prisma.novel.update({ where: { id }, data: { pov_character_id: input.pov_character_id } }),
    prisma.novelCharacterRelation.deleteMany({ where: { novel_id: id } }),
    prisma.novelCharacter.deleteMany({ where: { novel_id: id } })
  ]
  for (const link of input.character_links) {
    ops.push(
      prisma.novelCharacter.create({
        data: { novel_id: id, character_id: link.character_id, role: link.role, variant_id: link.variant_id }
      })
    )
  }
  for (const rel of input.relations) {
    ops.push(
      prisma.novelCharacterRelation.create({
        data: {
          novel_id: id,
          source_character_id: rel.source_character_id,
          target_character_id: rel.target_character_id,
          relation: rel.relation,
          description: rel.description,
          address_override: rel.address_override
        }
      })
    )
  }
  await prisma.$transaction(ops)
}

export async function saveOutline(prisma: PrismaClient, id: string, outlineJson: string) {
  return prisma.novel.update({
    where: { id },
    data: { outline: outlineJson }
  })
}

// 作品設計を保存する (作り直しも手動の編集も上書き)。章立てや本文には触れない。
export async function saveBible(prisma: PrismaClient, id: string, stored: StoredBible) {
  await prisma.novel.update({ where: { id }, data: { bible: JSON.stringify(stored) } })
}

// 章をどの章立てと、どの前章の版から作ったか。鮮度の判定 (staleness.ts) に使う。
export type ChapterLineage = {
  // 生成に使った章立ての、この章の項目のハッシュ
  outlineHash: string | null
  // 直前の章として使った version の id。第 1 章と、直前の章の本文が無かったときは null
  prevChapterId: string | null
}

// Chapter は append-only。再生成のたびに version をインクリメントして INSERT する。
// 表示は getNovelWithChapters で最新 version のみ抜き出すが、過去 version も DB には残る。
export async function saveChapter(
  prisma: PrismaClient,
  novelId: string,
  chapterNumber: number,
  content: string,
  title: string | null,
  prompt: string,
  lineage: ChapterLineage
) {
  const latest = await prisma.chapter.findFirst({
    where: { novel_id: novelId, chapter_number: chapterNumber },
    orderBy: { version: 'desc' },
    select: { version: true }
  })

  return prisma.chapter.create({
    data: {
      novel_id: novelId,
      chapter_number: chapterNumber,
      version: (latest?.version ?? 0) + 1,
      content,
      title,
      prompt,
      outline_hash: lineage.outlineHash,
      prev_chapter_id: lineage.prevChapterId
    }
  })
}

export type OutlineHashStamp = { id: string; outlineHash: string }

// outline_hash が null の章に変更前のハッシュを書き (outlineStamps)、それから章立てを保存する。
// D1 の $transaction([...]) は順に実行するだけで、途中で失敗すると前の書き込みは残る。そのため順序で安全側に倒す:
// ハッシュだけ書けて章立てが保存されなかった場合は、変更前の章立てとハッシュが一致するので「新しい」のまま (正しい)。
// 先に章立てを書くと、ハッシュを書けなかった古い本文が、書き換えた後も「新しい」に見えてしまう。
export async function saveOutlineWithStamps(
  prisma: PrismaClient,
  novelId: string,
  outlineJson: string,
  stamps: OutlineHashStamp[]
) {
  await prisma.$transaction([
    ...stamps.map((stamp) =>
      prisma.chapter.update({ where: { id: stamp.id }, data: { outline_hash: stamp.outlineHash } })
    ),
    prisma.novel.update({ where: { id: novelId }, data: { outline: outlineJson } })
  ])
}

// ---------------------- 鮮度 (純粋) ----------------------

export type LineageChapter = {
  id: string
  chapter_number: number
  outline_hash: string | null
  prev_chapter_id: string | null
}

// 章立ての 1 章ぶんの項目のハッシュ。章立てに無い章は、空の項目のハッシュ。
function entryHash(outline: Outline | null, chapterNumber: number): string {
  const entry = outline === null ? undefined : outline.chapters.find((ch) => ch.chapter_number === chapterNumber)
  return outlineEntryHash(entry === undefined ? { title: '', summary: '', characters: [] } : entry)
}

// 各章の最新 version の鮮度 (章番号 → 判定)。outline は今の章立て。
// 章立てが無い・壊れている (null) ときは章立ての比較を飛ばし、前の章の作り直しだけを見る
// (読めない章立てを理由に全章を「要再生成」にしない)。
export function chapterStaleness(chapters: LineageChapter[], outline: Outline | null): Map<number, ChapterStaleness> {
  const current = new Map(
    outline === null
      ? []
      : outline.chapters.map((entry): [number, string] => [entry.chapter_number, outlineEntryHash(entry)])
  )
  return computeStaleness(
    chapters.map((chapter) => ({
      number: chapter.chapter_number,
      id: chapter.id,
      outlineHash: outline === null ? null : chapter.outline_hash,
      prevChapterId: chapter.prev_chapter_id
    })),
    current
  )
}

// 章立てを書き換える前に、outline_hash が null の章 (この機能より前に生成された章) へ書き込むハッシュ。
// 変更前の章立てのその章の項目のハッシュ (項目が無ければ空の項目のハッシュ) を入れておくと、
// 書き換えた後の章立てと食い違った章だけが outline_changed になる (変わっていない章は一致して「新しい」のまま)。
// 対象は渡した章の最新 version 全部 (書き換えた章だけでなく、伏線の検証で直された章も拾うため)。
export function outlineStamps(chapters: LineageChapter[], previous: Outline | null): OutlineHashStamp[] {
  return chapters
    .filter((chapter) => chapter.outline_hash === null)
    .map((chapter) => ({ id: chapter.id, outlineHash: entryHash(previous, chapter.chapter_number) }))
}

// 章の記録を保存する (version ごとに 1:1。同じ version に抽出し直したら上書き)。
export async function saveChapterRecord(prisma: PrismaClient, chapterId: string, record: ChapterRecord) {
  await prisma.chapter.update({ where: { id: chapterId }, data: { record: JSON.stringify(record) } })
}

// 保存済みの 1 version (生成の再開で、記録の抽出に使う)。無ければ null。
export async function findChapterVersion(prisma: PrismaClient, chapterId: string) {
  const row = await prisma.chapter.findUnique({
    where: { id: chapterId },
    select: { id: true, novel_id: true, chapter_number: true, title: true, content: true, record: true }
  })
  return row === null ? null : { ...row, record: parseStoredRecord(row.record) }
}

// 指定章の全 version を新しい順で返す (生成履歴の閲覧用)。
export async function listChapterVersions(prisma: PrismaClient, novelId: string, chapterNumber: number) {
  const rows = await prisma.chapter.findMany({
    where: { novel_id: novelId, chapter_number: chapterNumber },
    orderBy: { version: 'desc' },
    select: { id: true, version: true, title: true, content: true, prompt: true, record: true, created_at: true }
  })
  return rows.map((row) => ({ ...row, record: parseStoredRecord(row.record) }))
}

// 各章の最新 version の id。rows は chapter_number 昇順・version 降順で並んでいる前提 (同じ章の先頭が最新)。
function latestVersionIds(rows: Array<{ id: string; chapter_number: number }>): string[] {
  const latest = new Map<number, string>()
  for (const row of rows) {
    if (!latest.has(row.chapter_number)) latest.set(row.chapter_number, row.id)
  }
  return [...latest.values()]
}

// 各章の最新 version を本文と記録つきで読む。prompt 列は読まない (1 version あたり数十 KB あり、一覧には要らない)。
async function latestChapters(prisma: PrismaClient, rows: Array<{ id: string; chapter_number: number }>) {
  const ids = latestVersionIds(rows)
  if (ids.length === 0) return []
  const chapters = await prisma.chapter.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      novel_id: true,
      chapter_number: true,
      version: true,
      title: true,
      content: true,
      record: true,
      outline_hash: true,
      prev_chapter_id: true,
      created_at: true
    }
  })
  return chapters
    .map((ch) => ({ ...ch, record: parseStoredRecord(ch.record) }))
    .sort((a, b) => a.chapter_number - b.chapter_number)
}

export async function getNovelWithChapters(prisma: PrismaClient, id: string) {
  const novel = await prisma.novel.findUnique({
    where: { id },
    include: {
      // 章は append-only。まず全 version の id と番号だけを読み、各章の最新の行だけを後で本文つきで読む
      // (全 version の本文と prompt を毎回読むと、章を作り直すたびに読む量が増えるため)。
      chapters: {
        select: { id: true, chapter_number: true, version: true },
        orderBy: [{ chapter_number: 'asc' }, { version: 'desc' }]
      },
      // Gemini プロンプト用に口調・呼び方等もまとめて読む (server 側でしか使わないので API レスポンスには載せない)。
      character_links: {
        include: {
          character: {
            select: {
              id: true,
              name: true,
              gender: true,
              age: true,
              occupation: true,
              appearance: true,
              first_person: true,
              address_others: true,
              speech_examples: true,
              description: true,
              // バリエーション本体も読む。生成時に variant_id で選び、空欄項目はベース継承でマージする。
              variants: {
                select: {
                  id: true,
                  age: true,
                  occupation: true,
                  appearance: true,
                  first_person: true,
                  address_others: true,
                  speech_examples: true,
                  description: true
                }
              }
            }
          }
        }
      },
      relations: {
        include: {
          source: { select: { id: true, name: true } },
          target: { select: { id: true, name: true } }
        }
      },
      generation_costs: { orderBy: [{ chapter_number: 'asc' }, { created_at: 'desc' }] },
      generation_job: true,
      category: { select: { id: true, name: true } }
    }
  })

  if (!novel) return null

  // chapter_number ごとに最新 version の章だけ (番号の昇順)。
  const chapters = await latestChapters(prisma, novel.chapters)

  // 本文 (kind = chapter) は chapter_number ごとに最新コスト行のみ表示。古い世代も DB には残る。
  // 章立てなどの行は同じ chapter_number を持ちうるので、最新を選ぶ前に本文だけに絞る。
  const chapterCostRows = novel.generation_costs.filter((row) => row.kind === 'chapter')
  const latestCostByChapter = new Map<number, (typeof novel.generation_costs)[0]>()
  for (const row of chapterCostRows) {
    if (!latestCostByChapter.has(row.chapter_number)) {
      latestCostByChapter.set(row.chapter_number, row)
    }
  }
  const generation_costs = Array.from(latestCostByChapter.values()).map((r) => ({
    chapter_number: r.chapter_number,
    model: r.model,
    prompt_tokens: r.prompt_tokens,
    output_tokens: r.output_tokens,
    cost_usd: r.cost_usd
  }))
  const total_cost_usd = generation_costs.reduce((sum, r) => sum + r.cost_usd, 0)
  // 本文以外 (章立て、作品設計、記録の抽出、検査) は作り直した分も実際に払っているので、全行を合計する。
  const aux_cost_usd = novel.generation_costs
    .filter((row) => row.kind !== 'chapter')
    .reduce((sum, row) => sum + row.cost_usd, 0)

  const bible = parseStoredBible(novel.bible)
  return {
    ...withWritingNotes(novel),
    // 作品設計 (検証済み。source_hash を含む)。未作成や壊れた値は null
    bible,
    // 列に値があるのに読めない (壊れている)。未作成 (null や空) とは区別する: 成人指定では、未作成と同じ扱い
    // (辞典の原文と読み替えの指示で書く) にせず生成を止めるため。
    bible_unreadable: novel.bible !== null && novel.bible.length > 0 && bible === null,
    chapters,
    cast: novel.character_links.map((l) => ({
      character_id: l.character_id,
      name: l.character.name,
      role: l.role,
      variant_id: l.variant_id
    })),
    relations: novel.relations.map((r) => ({
      source_character_id: r.source_character_id,
      source_name: r.source.name,
      target_character_id: r.target_character_id,
      target_name: r.target.name,
      relation: r.relation,
      description: r.description,
      address_override: r.address_override
    })),
    generation_costs,
    total_cost_usd,
    aux_cost_usd,
    generation_job: novel.generation_job
  }
}

export async function upsertGenerationJob(
  prisma: PrismaClient,
  novelId: string,
  data: { status: string; pending: string; current: number | null; model: string }
) {
  return prisma.novelGenerationJob.upsert({
    where: { novel_id: novelId },
    create: { novel_id: novelId, ...data },
    update: { ...data }
  })
}

export async function stopGenerationJob(prisma: PrismaClient, novelId: string) {
  return prisma.novelGenerationJob.updateMany({
    where: { novel_id: novelId, status: 'running' },
    data: { status: 'stopped' }
  })
}

export async function listNovels(prisma: PrismaClient) {
  // position 昇順 (ユーザー手動並び)。未設定はすべて 0 なので created_at 新しい順でタイブレーク。
  // 一覧はカテゴリでグループ化して表示するが、グループ化はこの順序を各カテゴリ内で保つ。
  const novels = await prisma.novel.findMany({
    orderBy: [{ position: 'asc' }, { created_at: 'desc' }],
    select: {
      id: true,
      title: true,
      genre: true,
      setting: true,
      num_chapters: true,
      target_chars: true,
      outline_summary_chars: true,
      pov: true,
      tone: true,
      age_rating: true,
      pov_character_id: true,
      ending: true,
      notes: true,
      writing_notes: true,
      editor_model: true,
      writer_model: true,
      outline: true,
      category_id: true,
      category: { select: { name: true } },
      created_at: true,
      updated_at: true
    }
  })
  return novels.map(withWritingNotes)
}

// 小説ごとの生成済み本文の合計文字数 (各 chapter_number の最新 version のみ集計)。
// 一覧は章本文を載せないので、ここで SUM(LENGTH(content)) を集計してまとめて返す。
export async function getWrittenCharCounts(prisma: PrismaClient): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<Array<{ novel_id: string; chars: number | bigint }>>`
    SELECT c.novel_id AS novel_id, SUM(LENGTH(c.content)) AS chars
    FROM Chapter c
    WHERE c.version = (
      SELECT MAX(c2.version) FROM Chapter c2
      WHERE c2.novel_id = c.novel_id AND c2.chapter_number = c.chapter_number
    )
    GROUP BY c.novel_id
  `
  const map = new Map<string, number>()
  for (const row of rows) map.set(row.novel_id, Number(row.chars))
  return map
}

// 整理ページの配置保存。カテゴリ (category_id, 未分類は null) ごとに、カード順で
// category_id と position(0..n-1) を一括更新する。カテゴリ移動と並び替えを同時に扱う。
// position はカテゴリごとに 0 始まりだが、一覧はカテゴリでグループ化するので破綻しない。
export async function arrangeNovels(
  prisma: PrismaClient,
  groups: Array<{ category_id: string | null; ids: string[] }>
) {
  const ops: Prisma.PrismaPromise<unknown>[] = []
  for (const group of groups) {
    group.ids.forEach((id, i) => {
      ops.push(prisma.novel.update({ where: { id }, data: { category_id: group.category_id, position: i } }))
    })
  }
  if (ops.length > 0) await prisma.$transaction(ops)
}

export async function listCategories(prisma: PrismaClient) {
  // position 昇順 (ユーザー手動並び)。未設定はすべて 0 なので name でタイブレーク。
  return prisma.category.findMany({
    orderBy: [{ position: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, _count: { select: { novels: true } } }
  })
}

// 同名カテゴリは作らず既存を返す (inline 作成で名前が被っても自然に選択できる)。
// 新規は末尾に積む (position = 既存最大 + 1)。
export async function createCategory(prisma: PrismaClient, name: string) {
  const existing = await prisma.category.findUnique({ where: { name } })
  if (existing) return existing
  const agg = await prisma.category.aggregate({ _max: { position: true } })
  const maxPos = agg._max.position
  const position = maxPos === null ? 0 : maxPos + 1
  return prisma.category.create({ data: { name, position } })
}

// 並び替え。受け取った id 順に position を 0..n-1 で振り直す。
export async function reorderCategories(prisma: PrismaClient, ids: string[]) {
  await prisma.$transaction(ids.map((id, i) => prisma.category.update({ where: { id }, data: { position: i } })))
  return listCategories(prisma)
}

type CategoryWithCount = { id: string; name: string; novel_count: number }

// リネーム。別カテゴリが同名なら 'name_taken'、対象が無ければ 'not_found'。
export async function renameCategory(
  prisma: PrismaClient,
  id: string,
  name: string
): Promise<{ status: 'ok'; category: CategoryWithCount } | { status: 'name_taken' } | { status: 'not_found' }> {
  const dup = await prisma.category.findUnique({ where: { name }, select: { id: true } })
  if (dup && dup.id !== id) return { status: 'name_taken' }
  const exists = await prisma.category.findUnique({ where: { id }, select: { id: true } })
  if (!exists) return { status: 'not_found' }
  const updated = await prisma.category.update({
    where: { id },
    data: { name },
    select: { id: true, name: true, _count: { select: { novels: true } } }
  })
  return { status: 'ok', category: { id: updated.id, name: updated.name, novel_count: updated._count.novels } }
}

// 削除。所属していた小説は FK の onDelete: SetNull で未分類 (category_id=null) に戻る。
// 既に無い id でも deleteMany なので throw しない。
export async function deleteCategory(prisma: PrismaClient, id: string) {
  await prisma.category.deleteMany({ where: { id } })
}

// キャスト・関係・語り手は saveNovelCast で管理するので本体更新では触らない。
export async function updateNovel(prisma: PrismaClient, id: string, input: CreateNovelInput) {
  const updated = await prisma.novel.update({
    where: { id },
    data: {
      title: input.title,
      genre: input.genre,
      setting: input.setting,
      num_chapters: input.num_chapters,
      target_chars: input.target_chars,
      outline_summary_chars: input.outline_summary_chars,
      pov: input.pov,
      tone: input.tone,
      age_rating: input.age_rating,
      ending: input.ending,
      notes: input.notes,
      writing_notes: input.writing_notes,
      editor_model: input.editor_model,
      writer_model: input.writer_model,
      category_id: input.category_id
    },
    include: { category: { select: { name: true } } }
  })
  return withWritingNotes(updated)
}

export async function deleteNovel(prisma: PrismaClient, id: string) {
  return prisma.novel.delete({ where: { id } })
}
