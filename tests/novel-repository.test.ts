import { describe, expect, test } from 'bun:test'
import type { PrismaClient } from '@/generated/prisma/client'
import {
  findChapterVersion,
  getNovelWithChapters,
  listChapterVersions,
  parseStoredRecord,
  saveChapterRecord
} from '@/lib/novel/repository'

const validRecord = {
  summary: '彩葉が港でヤチヨに会った。',
  facts: ['港の灯台は赤い'],
  characters: [{ name: '酒寄彩葉', actions: ['港へ行った'], learned: [], state: '' }],
  threads_opened: [],
  threads_resolved: [],
  end_state: { time: '夕方', place: '港', present: [] }
}

type Row = {
  id: string
  novel_id: string
  chapter_number: number
  version: number
  title: string | null
  content: string
  prompt: string | null
  record: string | null
  created_at: Date
}

function row(chapterNumber: number, version: number, record: string | null = null): Row {
  return {
    id: `c${chapterNumber}v${version}`,
    novel_id: 'n1',
    chapter_number: chapterNumber,
    version,
    title: `題${chapterNumber}`,
    content: `第${chapterNumber}章 v${version}`,
    prompt: 'とても長いプロンプト',
    record,
    created_at: new Date(0)
  }
}

type FindManyArgs = { where: { id?: { in: string[] } }; select: Record<string, boolean> }

// novel.findUnique は章の id・番号・version だけを返し、chapter.findMany は渡された id の行を返す偽物。
function fakePrisma(rows: Row[]) {
  const findManyCalls: FindManyArgs[] = []
  const novelArgs: unknown[] = []
  const sorted = [...rows].sort((a, b) => a.chapter_number - b.chapter_number || b.version - a.version)
  const prisma: PrismaClient = Object.assign(Object.create(null), {
    novel: {
      findUnique: async (args: unknown) => {
        novelArgs.push(args)
        return {
          id: 'n1',
          chapters: sorted.map((r) => ({ id: r.id, chapter_number: r.chapter_number, version: r.version })),
          character_links: [],
          relations: [],
          generation_costs: [],
          generation_job: null,
          category: null
        }
      }
    },
    chapter: {
      findMany: async (args: FindManyArgs) => {
        findManyCalls.push(args)
        const ids = args.where.id === undefined ? [] : args.where.id.in
        // 並びは保証しない (呼び出し側が並べ直す)
        return rows
          .filter((r) => ids.includes(r.id))
          .reverse()
          .map((r) => Object.fromEntries(Object.keys(args.select).map((key) => [key, r[key as keyof Row]])))
      }
    }
  })
  return { prisma, findManyCalls, novelArgs }
}

describe('getNovelWithChapters', () => {
  test('returns only the latest version of each chapter, in number order', async () => {
    const { prisma } = fakePrisma([row(1, 1), row(1, 2), row(2, 1), row(3, 1), row(3, 3), row(3, 2)])
    const novel = await getNovelWithChapters(prisma, 'n1')
    if (novel === null) throw new Error('novel expected')
    expect(novel.chapters.map((c) => [c.chapter_number, c.version])).toEqual([
      [1, 2],
      [2, 1],
      [3, 3]
    ])
    expect(novel.chapters[2].content).toBe('第3章 v3')
  })

  test('reads ids first, then the latest rows without the prompt column', async () => {
    const { prisma, findManyCalls, novelArgs } = fakePrisma([row(1, 1), row(1, 2), row(2, 1)])
    await getNovelWithChapters(prisma, 'n1')
    expect(novelArgs[0]).toMatchObject({
      include: { chapters: { select: { id: true, chapter_number: true, version: true } } }
    })
    expect(findManyCalls).toHaveLength(1)
    expect(findManyCalls[0].where).toEqual({ id: { in: ['c1v2', 'c2v1'] } })
    expect(findManyCalls[0].select.prompt).toBeUndefined()
    expect(findManyCalls[0].select.content).toBe(true)
    expect(findManyCalls[0].select.record).toBe(true)
  })

  test('validates stored records', async () => {
    const { prisma } = fakePrisma([
      row(1, 1, JSON.stringify(validRecord)),
      row(2, 1, JSON.stringify({ summary: '' })),
      row(3, 1, '{not json'),
      row(4, 1, null)
    ])
    const novel = await getNovelWithChapters(prisma, 'n1')
    if (novel === null) throw new Error('novel expected')
    expect(novel.chapters[0].record).toEqual(validRecord)
    expect(novel.chapters.slice(1).map((c) => c.record)).toEqual([null, null, null])
  })

  test('the record of an older version is not used', async () => {
    const { prisma } = fakePrisma([row(1, 1, JSON.stringify(validRecord)), row(1, 2, null)])
    const novel = await getNovelWithChapters(prisma, 'n1')
    expect(novel?.chapters[0].record).toBeNull()
  })

  test('no chapters means no second query', async () => {
    const { prisma, findManyCalls } = fakePrisma([])
    const novel = await getNovelWithChapters(prisma, 'n1')
    expect(novel?.chapters).toEqual([])
    expect(findManyCalls).toHaveLength(0)
  })
})

describe('listChapterVersions', () => {
  test('returns every version with a validated record', async () => {
    const rows = [row(1, 2, JSON.stringify(validRecord)), row(1, 1, 'garbage')]
    const prisma: PrismaClient = Object.assign(Object.create(null), {
      chapter: { findMany: async () => rows.map((r) => ({ ...r })) }
    })
    const versions = await listChapterVersions(prisma, 'n1', 1)
    expect(versions.map((v) => [v.version, v.record])).toEqual([
      [2, validRecord],
      [1, null]
    ])
    expect(versions[0].prompt).toBe('とても長いプロンプト')
  })
})

describe('saveChapterRecord and findChapterVersion', () => {
  test('stores the record as JSON on the version', async () => {
    const updates: unknown[] = []
    const prisma: PrismaClient = Object.assign(Object.create(null), {
      chapter: {
        update: async (args: unknown) => {
          updates.push(args)
        }
      }
    })
    await saveChapterRecord(prisma, 'c1v2', validRecord)
    expect(updates).toEqual([{ where: { id: 'c1v2' }, data: { record: JSON.stringify(validRecord) } }])
  })

  test('findChapterVersion validates the record and returns null for a missing row', async () => {
    const stored = row(2, 1, JSON.stringify({ summary: '' }))
    const prisma: PrismaClient = Object.assign(Object.create(null), {
      chapter: { findUnique: async (args: { where: { id: string } }) => (args.where.id === stored.id ? stored : null) }
    })
    expect(await findChapterVersion(prisma, 'nope')).toBeNull()
    const found = await findChapterVersion(prisma, stored.id)
    expect(found).toMatchObject({ id: 'c2v1', chapter_number: 2, content: '第2章 v1', record: null })
  })
})

describe('parseStoredRecord', () => {
  test('fills defaults and rejects broken values', () => {
    expect(parseStoredRecord(JSON.stringify({ summary: 'だけ' }))).toEqual({
      summary: 'だけ',
      facts: [],
      characters: [],
      threads_opened: [],
      threads_resolved: [],
      end_state: { time: '', place: '', present: [] }
    })
    expect(parseStoredRecord(null)).toBeNull()
    expect(parseStoredRecord('')).toBeNull()
    expect(parseStoredRecord('[]')).toBeNull()
  })
})
