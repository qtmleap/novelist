import type { Prisma, PrismaClient } from '@/generated/prisma/client'
import type { CreateNovelInput } from '@/schemas/novel.dto'

export async function createNovel(prisma: PrismaClient, input: CreateNovelInput) {
  const novel = await prisma.novel.create({
    data: {
      title: input.title,
      genre: input.genre,
      characters: input.characters,
      setting: input.setting,
      num_chapters: input.num_chapters,
      target_chars: input.target_chars,
      pov: input.pov,
      tone: input.tone,
      age_rating: input.age_rating,
      pov_character_id: input.pov_character_id,
      ending: input.ending,
      notes: input.notes,
      editor_model: input.editor_model,
      writer_model: input.writer_model,
      category_id: input.category_id
    },
    include: { category: { select: { name: true } } }
  })

  const ops: Prisma.PrismaPromise<unknown>[] = []

  for (const link of input.character_links) {
    ops.push(
      prisma.novelCharacter.create({
        data: { novel_id: novel.id, character_id: link.character_id, role: link.role }
      })
    )
  }

  for (const rel of input.relations) {
    ops.push(
      prisma.novelCharacterRelation.create({
        data: {
          novel_id: novel.id,
          source_character_id: rel.source_character_id,
          target_character_id: rel.target_character_id,
          relation: rel.relation,
          description: rel.description,
          address_override: rel.address_override
        }
      })
    )
  }

  if (ops.length > 0) {
    await prisma.$transaction(ops)
  }

  return novel
}

export async function saveOutline(prisma: PrismaClient, id: string, outlineJson: string) {
  return prisma.novel.update({
    where: { id },
    data: { outline: outlineJson }
  })
}

// Chapter は append-only。再生成のたびに version をインクリメントして INSERT する。
// 表示は getNovelWithChapters で最新 version のみ抜き出すが、過去 version も DB には残る。
export async function saveChapter(
  prisma: PrismaClient,
  novelId: string,
  chapterNumber: number,
  content: string,
  title: string | null,
  prompt: string
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
      prompt
    }
  })
}

// 指定章の全 version を新しい順で返す (生成履歴の閲覧用)。
export async function listChapterVersions(prisma: PrismaClient, novelId: string, chapterNumber: number) {
  return prisma.chapter.findMany({
    where: { novel_id: novelId, chapter_number: chapterNumber },
    orderBy: { version: 'desc' },
    select: { id: true, version: true, title: true, content: true, prompt: true, created_at: true }
  })
}

export async function getNovelWithChapters(prisma: PrismaClient, id: string) {
  const novel = await prisma.novel.findUnique({
    where: { id },
    include: {
      // 章は append-only なので全 version 読んでアプリ側で最新だけ残す。
      chapters: { orderBy: [{ chapter_number: 'asc' }, { version: 'desc' }] },
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
              description: true
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

  // chapter_number ごとに最新 version の章だけ残す。
  const latestChapterByNumber = new Map<number, (typeof novel.chapters)[0]>()
  for (const ch of novel.chapters) {
    if (!latestChapterByNumber.has(ch.chapter_number)) {
      latestChapterByNumber.set(ch.chapter_number, ch)
    }
  }
  const chapters = Array.from(latestChapterByNumber.values()).sort((a, b) => a.chapter_number - b.chapter_number)

  // chapter_number ごとに最新コスト行のみ表示。古い世代も DB には残る。
  const latestCostByChapter = new Map<number, (typeof novel.generation_costs)[0]>()
  for (const row of novel.generation_costs) {
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

  return {
    ...novel,
    chapters,
    cast: novel.character_links.map((l) => ({
      character_id: l.character_id,
      name: l.character.name,
      role: l.role
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
  return prisma.novel.findMany({
    orderBy: [{ position: 'asc' }, { created_at: 'desc' }],
    select: {
      id: true,
      title: true,
      genre: true,
      characters: true,
      setting: true,
      num_chapters: true,
      target_chars: true,
      pov: true,
      tone: true,
      age_rating: true,
      pov_character_id: true,
      ending: true,
      notes: true,
      editor_model: true,
      writer_model: true,
      outline: true,
      category_id: true,
      category: { select: { name: true } },
      created_at: true,
      updated_at: true
    }
  })
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

export async function updateNovel(prisma: PrismaClient, id: string, input: CreateNovelInput) {
  // D1 はインタラクティブトランザクション非対応のため $transaction([...]) で順序実行する。
  // 既存の cast / relations は一旦消してから input に従って入れ直す。
  const ops: Prisma.PrismaPromise<unknown>[] = [
    prisma.novel.update({
      where: { id },
      data: {
        title: input.title,
        genre: input.genre,
        characters: input.characters,
        setting: input.setting,
        num_chapters: input.num_chapters,
        target_chars: input.target_chars,
        pov: input.pov,
        tone: input.tone,
        age_rating: input.age_rating,
        pov_character_id: input.pov_character_id,
        ending: input.ending,
        notes: input.notes,
        editor_model: input.editor_model,
        writer_model: input.writer_model,
        category_id: input.category_id
      },
      include: { category: { select: { name: true } } }
    }),
    prisma.novelCharacterRelation.deleteMany({ where: { novel_id: id } }),
    prisma.novelCharacter.deleteMany({ where: { novel_id: id } })
  ]

  for (const link of input.character_links) {
    ops.push(
      prisma.novelCharacter.create({
        data: { novel_id: id, character_id: link.character_id, role: link.role }
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

  const results = await prisma.$transaction(ops)
  return results[0] as Prisma.NovelGetPayload<{ include: { category: { select: { name: true } } } }>
}

export async function deleteNovel(prisma: PrismaClient, id: string) {
  return prisma.novel.delete({ where: { id } })
}
