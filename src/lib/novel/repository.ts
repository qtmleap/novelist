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
      pov_character_id: input.pov_character_id,
      ending: input.ending
    }
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
  title: string | null
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
      title
    }
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
      generation_costs: { orderBy: [{ chapter_number: 'asc' }, { created_at: 'desc' }] }
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
    total_cost_usd
  }
}

export async function listNovels(prisma: PrismaClient) {
  return prisma.novel.findMany({
    orderBy: { created_at: 'desc' },
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
      pov_character_id: true,
      ending: true,
      outline: true,
      created_at: true,
      updated_at: true
    }
  })
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
        pov_character_id: input.pov_character_id,
        ending: input.ending
      }
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
  return results[0] as Awaited<ReturnType<typeof prisma.novel.update>>
}

export async function deleteNovel(prisma: PrismaClient, id: string) {
  return prisma.novel.delete({ where: { id } })
}
