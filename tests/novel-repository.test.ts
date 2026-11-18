import { describe, expect, test } from 'bun:test'
import type { PrismaClient } from '@/generated/prisma/client'
import { outlineEntryHash } from '@/lib/novel/staleness'
import type { Outline } from '@/schemas/novel.dto'
import {
  findChapterVersion,
  getNovelWithChapters,
  listChapterVersions,
  parseStoredBible,
  outlineStamps,
  parseStoredRecord,
  parseStoredReview,
  saveBible,
  saveChapterReview,
  saveChapter,
  saveOutlineWithStamps,
  chapterStaleness,
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
  outline_hash: string | null
  prev_chapter_id: string | null
  review: string | null
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
    outline_hash: null,
    prev_chapter_id: null,
    review: null,
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
          bible: null,
          writing_notes: null,
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

describe('bible and writing_notes', () => {
  const stored = {
    premise: '核',
    ending: '',
    arcs: [],
    world: { rules: [], terms: [] },
    timeline: [],
    addresses: [],
    cast: [],
    source_hash: 'abc'
  }

  function novelPrisma(fields: { bible: string | null; writing_notes: string | null; age_rating?: string }): PrismaClient {
    return Object.assign(Object.create(null), {
      novel: {
        findUnique: async () => ({
          id: 'n1',
          chapters: [],
          character_links: [],
          relations: [],
          generation_costs: [],
          generation_job: null,
          category: null,
          age_rating: '全年齢',
          ...fields
        })
      }
    })
  }

  test('getNovelWithChapters reads an unknown age rating as all ages', async () => {
    for (const [stored, read] of [
      ['R18', 'R18'],
      ['R15', 'R15'],
      ['全年齢', '全年齢'],
      ['R18G', '全年齢'],
      ['r18', '全年齢'],
      ['R18 ', '全年齢']
    ]) {
      const novel = await getNovelWithChapters(novelPrisma({ bible: null, writing_notes: null, age_rating: stored }), 'n1')
      expect(novel?.age_rating).toBe(read)
    }
  })

  test('getNovelWithChapters reads a null writing_notes as empty and validates the bible', async () => {
    const novel = await getNovelWithChapters(novelPrisma({ bible: JSON.stringify(stored), writing_notes: null }), 'n1')
    expect(novel?.writing_notes).toBe('')
    expect(novel?.bible).toEqual(stored)
    const broken = await getNovelWithChapters(novelPrisma({ bible: '{oops', writing_notes: '擬音語なし' }), 'n1')
    expect(broken?.bible).toBeNull()
    // 値があるのに読めないのと、未作成とを区別する
    expect(broken?.bible_unreadable).toBe(true)
    const missing = await getNovelWithChapters(novelPrisma({ bible: null, writing_notes: null }), 'n1')
    expect(missing?.bible_unreadable).toBe(false)
    const fresh = await getNovelWithChapters(novelPrisma({ bible: JSON.stringify(stored), writing_notes: null }), 'n1')
    expect(fresh?.bible_unreadable).toBe(false)
    expect(broken?.writing_notes).toBe('擬音語なし')
  })

  test('parseStoredBible fills defaults and rejects broken values', () => {
    expect(parseStoredBible(JSON.stringify({ premise: 'だけ' }))).toMatchObject({ premise: 'だけ', source_hash: '' })
    expect(parseStoredBible(null)).toBeNull()
    expect(parseStoredBible('')).toBeNull()
    expect(parseStoredBible(JSON.stringify({ addresses: [{ from: '', to: 'b', call: 'c' }] }))).toBeNull()
  })

  test('saveBible stores the JSON on the novel', async () => {
    const updates: unknown[] = []
    const prisma: PrismaClient = Object.assign(Object.create(null), {
      novel: {
        update: async (args: unknown) => {
          updates.push(args)
        }
      }
    })
    await saveBible(prisma, 'n1', stored)
    expect(updates).toEqual([{ where: { id: 'n1' }, data: { bible: JSON.stringify(stored) } }])
  })
})

// ---------------------- 鮮度 (Phase 4) ----------------------

function entry(n: number, summary = `概要${n}`) {
  return {
    chapter_number: n,
    title: `題${n}`,
    summary,
    characters: [],
    events: [],
    time_place: '',
    end_state: '',
    setups: [],
    payoffs: []
  }
}
const outline: Outline = { chapters: [entry(1), entry(2), entry(3)] }
const hashOf = (n: number, summary?: string) => outlineEntryHash(entry(n, summary))

describe('chapterStaleness', () => {
  test('a chapter whose outline entry changed is stale, and the chapters after it follow', () => {
    const chapters = [
      { id: 'v1', chapter_number: 1, outline_hash: hashOf(1), prev_chapter_id: null },
      { id: 'v2', chapter_number: 2, outline_hash: hashOf(2, '前の概要'), prev_chapter_id: 'v1' },
      { id: 'v3', chapter_number: 3, outline_hash: hashOf(3), prev_chapter_id: 'v2' }
    ]
    const result = chapterStaleness(chapters, outline)
    expect(result.get(1)).toEqual({ stale: false, reasons: [] })
    expect(result.get(2)).toEqual({ stale: true, reasons: ['outline_changed'] })
    expect(result.get(3)).toEqual({ stale: true, reasons: ['previous_stale'] })
  })

  test('a chapter written from an older version of the previous chapter is stale', () => {
    const chapters = [
      { id: 'v1b', chapter_number: 1, outline_hash: hashOf(1), prev_chapter_id: null },
      { id: 'v2', chapter_number: 2, outline_hash: hashOf(2), prev_chapter_id: 'v1a' }
    ]
    expect(chapterStaleness(chapters, outline).get(2)).toEqual({ stale: true, reasons: ['previous_regenerated'] })
  })

  test('chapters from before this feature (null) are not judged', () => {
    const chapters = [
      { id: 'v1', chapter_number: 1, outline_hash: null, prev_chapter_id: null },
      { id: 'v2', chapter_number: 2, outline_hash: null, prev_chapter_id: null }
    ]
    const result = chapterStaleness(chapters, outline)
    expect([...result.values()]).toEqual([
      { stale: false, reasons: [] },
      { stale: false, reasons: [] }
    ])
  })

  test('an unreadable outline only skips the outline comparison', () => {
    const chapters = [
      { id: 'v1b', chapter_number: 1, outline_hash: 'x', prev_chapter_id: null },
      { id: 'v2', chapter_number: 2, outline_hash: 'y', prev_chapter_id: 'v1a' }
    ]
    const result = chapterStaleness(chapters, null)
    expect(result.get(1)).toEqual({ stale: false, reasons: [] })
    expect(result.get(2)).toEqual({ stale: true, reasons: ['previous_regenerated'] })
  })
})

describe('outlineStamps', () => {
  const legacy = [
    { id: 'v1', chapter_number: 1, outline_hash: null, prev_chapter_id: null },
    { id: 'v2', chapter_number: 2, outline_hash: null, prev_chapter_id: null },
    { id: 'v4', chapter_number: 4, outline_hash: null, prev_chapter_id: null },
    { id: 'v3', chapter_number: 3, outline_hash: hashOf(3), prev_chapter_id: null }
  ]

  test('null hashes get the previous outline hash; chapters already stamped are left alone', () => {
    const stamps = outlineStamps(legacy, outline)
    expect(stamps).toEqual([
      { id: 'v1', outlineHash: hashOf(1) },
      { id: 'v2', outlineHash: hashOf(2) },
      // 変更前の章立てに項目が無い章は、空の項目のハッシュ
      { id: 'v4', outlineHash: outlineEntryHash({ title: '', summary: '', characters: [] }) }
    ])
    expect(outlineStamps(legacy, null).map((s) => s.id)).toEqual(['v1', 'v2', 'v4'])
  })

  test('after the outline changes, only the changed chapters become outline_changed', () => {
    const stamped = legacy.map((chapter) => {
      const stamp = outlineStamps(legacy, outline).find((s) => s.id === chapter.id)
      return stamp === undefined ? chapter : { ...chapter, outline_hash: stamp.outlineHash }
    })
    const changed: Outline = { chapters: [entry(1), entry(2, '書き直した概要'), entry(3), entry(4)] }
    const result = chapterStaleness(stamped, changed)
    expect(result.get(1)).toEqual({ stale: false, reasons: [] })
    expect(result.get(2)).toEqual({ stale: true, reasons: ['outline_changed'] })
    // 第 4 章は、変更前の章立てに項目が無かったので、項目ができたら変わったとみなす
    expect(result.get(4)?.reasons).toContain('outline_changed')
  })
})

describe('lineage writes', () => {
  test('saveChapter stores the outline hash and the previous chapter id', async () => {
    const created: unknown[] = []
    const prisma: PrismaClient = Object.assign(Object.create(null), {
      chapter: {
        findFirst: async () => ({ version: 2 }),
        create: async (args: unknown) => {
          created.push(args)
          return { id: 'new' }
        }
      }
    })
    await saveChapter(prisma, 'n1', 3, '本文', '題', 'プロンプト', { outlineHash: 'h3', prevChapterId: 'v2' })
    expect(created[0]).toMatchObject({
      data: { chapter_number: 3, version: 3, outline_hash: 'h3', prev_chapter_id: 'v2' }
    })
  })

  test('saveOutlineWithStamps writes the stamps and the outline in one transaction', async () => {
    const ops: unknown[] = []
    const batches: unknown[][] = []
    const prisma: PrismaClient = Object.assign(Object.create(null), {
      chapter: { update: (args: unknown) => ops.push({ chapter: args }) && { chapter: args } },
      novel: { update: (args: unknown) => ops.push({ novel: args }) && { novel: args } },
      $transaction: async (batch: unknown[]) => {
        batches.push(batch)
      }
    })
    await saveOutlineWithStamps(prisma, 'n1', '{"chapters":[]}', [{ id: 'v1', outlineHash: 'h1' }])
    expect(batches).toHaveLength(1)
    expect(batches[0]).toEqual([
      { chapter: { where: { id: 'v1' }, data: { outline_hash: 'h1' } } },
      { novel: { where: { id: 'n1' }, data: { outline: '{"chapters":[]}' } } }
    ])
  })

  test('getNovelWithChapters reads the lineage columns', async () => {
    const { prisma, findManyCalls } = fakePrisma([row(1, 1)])
    await getNovelWithChapters(prisma, 'n1')
    expect(findManyCalls[0].select.outline_hash).toBe(true)
    expect(findManyCalls[0].select.prev_chapter_id).toBe(true)
  })
})

// ---------------------- 検査 (Phase 5) ----------------------

describe('chapter review', () => {
  const review = {
    checks: [{ kind: 'length', message: '短い' }],
    issues: [{ kind: 'fact', quote: '灯台は赤かった', reason: '白いはず' }],
    reviewed: true
  }

  test('parseStoredReview fills defaults and rejects broken values', () => {
    expect(parseStoredReview(JSON.stringify(review))).toEqual(review)
    expect(parseStoredReview(JSON.stringify({}))).toEqual({ checks: [], issues: [], reviewed: false })
    expect(parseStoredReview(null)).toBeNull()
    expect(parseStoredReview('')).toBeNull()
    expect(parseStoredReview('{oops')).toBeNull()
    expect(parseStoredReview(JSON.stringify({ issues: [{ kind: 'unknown', quote: 'q', reason: 'r' }] }))).toBeNull()
  })

  test('saveChapterReview stores the JSON on the version', async () => {
    const updates: unknown[] = []
    const prisma: PrismaClient = Object.assign(Object.create(null), {
      chapter: {
        update: async (args: unknown) => {
          updates.push(args)
        }
      }
    })
    await saveChapterReview(prisma, 'v3', review)
    expect(updates).toEqual([{ where: { id: 'v3' }, data: { review: JSON.stringify(review) } }])
  })

  test('getNovelWithChapters and listChapterVersions return the validated review', async () => {
    const { prisma, findManyCalls } = fakePrisma([
      { ...row(1, 1), review: JSON.stringify(review) },
      { ...row(2, 1), review: '{oops' }
    ])
    const novel = await getNovelWithChapters(prisma, 'n1')
    expect(novel?.chapters.map((c) => c.review)).toEqual([review, null])
    expect(findManyCalls[0].select.review).toBe(true)
    const rows = [
      { ...row(1, 2), review: JSON.stringify(review) },
      { ...row(1, 1), review: null }
    ]
    const versionsPrisma: PrismaClient = Object.assign(Object.create(null), {
      chapter: { findMany: async () => rows.map((r) => ({ ...r })) }
    })
    const versions = await listChapterVersions(versionsPrisma, 'n1', 1)
    expect(versions.map((v) => v.review)).toEqual([review, null])
  })
})
