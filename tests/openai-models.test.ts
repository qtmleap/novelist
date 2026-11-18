import { describe, expect, test } from 'bun:test'
import { contextWindowOf } from '@/lib/openai/models'
import { UpstreamModelSchema } from '@/schemas/provider.dto'

// /models の 1 件を、実際の取り込みと同じく UpstreamModelSchema に通してから読む。
function read(item: Record<string, unknown>): number | null {
  const parsed = UpstreamModelSchema.safeParse({ id: 'm', ...item })
  if (!parsed.success) throw new Error(parsed.error.message)
  return contextWindowOf(parsed.data)
}

describe('contextWindowOf', () => {
  test('reads each server family field name', () => {
    expect(read({ context_window: 32_768 })).toBe(32_768)
    // OpenRouter
    expect(read({ context_length: 131_072 })).toBe(131_072)
    // vLLM
    expect(read({ max_model_len: 8_192 })).toBe(8_192)
  })

  test('takes context_window, then context_length, then max_model_len', () => {
    expect(read({ context_window: 1_000, context_length: 2_000, max_model_len: 3_000 })).toBe(1_000)
    expect(read({ context_length: 2_000, max_model_len: 3_000 })).toBe(2_000)
  })

  test('skips values that are not positive integers', () => {
    expect(read({ context_window: null, context_length: 4_096 })).toBe(4_096)
    expect(read({ context_window: 0, max_model_len: 2_048 })).toBe(2_048)
    expect(read({ context_window: 1.5, context_length: '8192', max_model_len: -1 })).toBeNull()
    expect(read({})).toBeNull()
  })

  test('odd values do not drop the model from the list', () => {
    expect(UpstreamModelSchema.safeParse({ id: 'm', context_window: null, max_model_len: 'big' }).success).toBe(true)
  })
})
