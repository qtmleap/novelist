import { describe, expect, test } from 'bun:test'
import { AGE_RATING_OPTIONS, CreateNovelSchema, DEFAULT_EDITOR_MODEL, DEFAULT_WRITER_MODEL, normalizeAgeRating } from '@/schemas/novel.dto'

describe('normalizeAgeRating', () => {
  test('選択肢の 3 値はそのまま返す', () => {
    for (const value of AGE_RATING_OPTIONS) expect(normalizeAgeRating(value)).toBe(value)
  })

  test('知らない値は全年齢にする (寄せない)', () => {
    for (const value of ['R18G', 'r18', 'R18 ', ' R18', 'R-18', 'r15', 'ALL', '']) {
      expect(normalizeAgeRating(value)).toBe('全年齢')
    }
  })
})

describe('CreateNovelSchema.age_rating', () => {
  const base = {
    title: 't',
    genre: 'ファンタジー',
    setting: '',
    num_chapters: 3,
    editor_model: DEFAULT_EDITOR_MODEL,
    writer_model: DEFAULT_WRITER_MODEL
  }

  test('選択肢の値は受け付ける', () => {
    for (const value of AGE_RATING_OPTIONS) {
      const parsed = CreateNovelSchema.safeParse({ ...base, age_rating: value })
      expect(parsed.success).toBe(true)
      if (parsed.success) expect(parsed.data.age_rating).toBe(value)
    }
  })

  test('知らない値は拒否する', () => {
    for (const value of ['R18G', 'r18', 'R18 ', '']) {
      expect(CreateNovelSchema.safeParse({ ...base, age_rating: value }).success).toBe(false)
    }
  })

  test('省略したら全年齢になる', () => {
    const parsed = CreateNovelSchema.safeParse(base)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.age_rating).toBe('全年齢')
  })
})
