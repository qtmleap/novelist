import { describe, expect, test } from 'bun:test'
import {
  chapterHasReview,
  REVIEW_POLL_MAX_ATTEMPTS,
  shouldPollAgain,
  startReviewPolling
} from '@/lib/review-polling'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('chapterHasReview', () => {
  const chapters = [
    { chapter_number: 1, review: { checks: [] } },
    { chapter_number: 2, review: null }
  ]
  test('検査の結果がある章だけ true', () => {
    expect(chapterHasReview(chapters, 1)).toBe(true)
    expect(chapterHasReview(chapters, 2)).toBe(false)
  })
  test('章が無ければ false', () => {
    expect(chapterHasReview(chapters, 3)).toBe(false)
  })
})

describe('shouldPollAgain', () => {
  test('結果が入ったら止める', () => {
    expect(shouldPollAgain(true, 0)).toBe(false)
  })
  test('結果が無く、回数が残っていれば続ける', () => {
    expect(shouldPollAgain(false, 0)).toBe(true)
    expect(shouldPollAgain(false, REVIEW_POLL_MAX_ATTEMPTS - 1)).toBe(true)
  })
  test('回数が尽きたら止める', () => {
    expect(shouldPollAgain(false, REVIEW_POLL_MAX_ATTEMPTS)).toBe(false)
  })
})

describe('startReviewPolling', () => {
  test('結果が入った回で止まり、onSettled を 1 回呼ぶ', async () => {
    const calls = { check: 0, settled: 0 }
    startReviewPolling({
      intervalMs: 1,
      check: async () => {
        calls.check += 1
        return calls.check === 3
      },
      onSettled: () => {
        calls.settled += 1
      }
    })
    await sleep(60)
    expect(calls).toEqual({ check: 3, settled: 1 })
  })

  test('結果が入らなければ最大回数で止まる', async () => {
    const calls = { check: 0, settled: 0 }
    startReviewPolling({
      intervalMs: 1,
      check: async () => {
        calls.check += 1
        return false
      },
      onSettled: () => {
        calls.settled += 1
      }
    })
    await sleep(400)
    expect(calls).toEqual({ check: REVIEW_POLL_MAX_ATTEMPTS, settled: 1 })
  })

  test('通信の失敗は「まだ無い」として続ける', async () => {
    const calls = { check: 0, settled: 0 }
    startReviewPolling({
      intervalMs: 1,
      check: async () => {
        calls.check += 1
        if (calls.check < 3) throw new Error('network')
        return true
      },
      onSettled: () => {
        calls.settled += 1
      }
    })
    await sleep(60)
    expect(calls).toEqual({ check: 3, settled: 1 })
  })

  test('止めたら、以降は取り直さず onSettled も呼ばない', async () => {
    const calls = { check: 0, settled: 0 }
    const stop = startReviewPolling({
      intervalMs: 20,
      check: async () => {
        calls.check += 1
        return false
      },
      onSettled: () => {
        calls.settled += 1
      }
    })
    stop()
    await sleep(80)
    expect(calls).toEqual({ check: 0, settled: 0 })
  })

  test('取り直しの最中に止めたら、次を張らず onSettled も呼ばない', async () => {
    const calls = { check: 0, settled: 0 }
    const stop = startReviewPolling({
      intervalMs: 1,
      check: async () => {
        calls.check += 1
        await sleep(20)
        return true
      },
      onSettled: () => {
        calls.settled += 1
      }
    })
    await sleep(10)
    stop()
    await sleep(60)
    expect(calls).toEqual({ check: 1, settled: 0 })
  })
})
