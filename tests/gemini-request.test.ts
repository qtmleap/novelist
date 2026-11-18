import { afterEach, describe, expect, test } from 'bun:test'
import type { Env } from '@/lib/db'
import { buildGeminiBody, generateJson } from '@/lib/gemini/client'

const SAFETY_OFF = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' }
]

const schema = {
  type: 'object',
  properties: { chapters: { type: 'array', items: { type: 'object' } } },
  required: ['chapters']
}

describe('buildGeminiBody', () => {
  test('json with system and schema uses systemInstruction and responseFormat', () => {
    const body = buildGeminiBody({ kind: 'json', prompt: { system: 's', user: 'u' }, schema })
    expect(body).toEqual({
      systemInstruction: { parts: [{ text: 's' }] },
      contents: [{ role: 'user', parts: [{ text: 'u' }] }],
      safetySettings: SAFETY_OFF,
      generationConfig: { responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema } } }
    })
  })

  test('json without schema falls back to responseMimeType', () => {
    const body = buildGeminiBody({ kind: 'json', prompt: { system: 's', user: 'u' } })
    expect(body.generationConfig).toEqual({ responseMimeType: 'application/json' })
  })

  test('the deprecated responseSchema is never sent', () => {
    const body = buildGeminiBody({ kind: 'json', prompt: { system: 's', user: 'u' }, schema })
    expect(JSON.stringify(body)).not.toContain('responseSchema')
  })

  test('an empty system omits systemInstruction', () => {
    const body = buildGeminiBody({ kind: 'json', prompt: { system: '', user: 'u' }, schema })
    expect('systemInstruction' in body).toBe(false)
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'u' }] }])
  })

  test('stream keeps temperature 0.9 and splits system and user', () => {
    const body = buildGeminiBody({ kind: 'stream', prompt: { system: 's', user: 'u' } })
    expect(body).toEqual({
      systemInstruction: { parts: [{ text: 's' }] },
      contents: [{ role: 'user', parts: [{ text: 'u' }] }],
      safetySettings: SAFETY_OFF,
      generationConfig: { temperature: 0.9 }
    })
  })

  test('stream without system', () => {
    const body = buildGeminiBody({ kind: 'stream', prompt: { system: '', user: 'u' } })
    expect('systemInstruction' in body).toBe(false)
    expect(body.generationConfig).toEqual({ temperature: 0.9 })
  })
})

// generateJson は fetch を差し替えて確かめる (本物の API には送らない)。
describe('generateJson (Gemini, fetch stubbed)', () => {
  const realFetch = globalThis.fetch
  const env: Env = Object.assign(Object.create(null), { GEMINI_API_KEY: 'test-key' })

  type Sent = { url: string; body: Record<string, unknown> }

  function okResponse(text: string): Response {
    const body = {
      candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2, totalTokenCount: 17 }
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  // responses を順に返す偽の fetch。送った要求を sent に残す。
  function stubFetch(responses: Response[]): Sent[] {
    const sent: Sent[] = []
    const queue = [...responses]
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        sent.push({ url: String(input), body: JSON.parse(String(init?.body)) })
        const next = queue.shift()
        if (next === undefined) throw new Error('unexpected extra fetch')
        return next
      },
      { preconnect: realFetch.preconnect }
    )
    return sent
  }

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('sends the schema and returns text with usage', async () => {
    const sent = stubFetch([okResponse('{"chapters":[]}')])
    const result = await generateJson(env, 'gemini-2.5-flash', { system: 's', user: 'u' }, { op: 'op', schema })
    expect(result).toEqual({
      text: '{"chapters":[]}',
      usage: { model: 'gemini-2.5-flash', promptTokens: 10, outputTokens: 7, totalTokens: 17 }
    })
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toContain('/gemini-2.5-flash:generateContent?key=test-key')
    expect(sent[0].body.generationConfig).toEqual({
      responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema } }
    })
  })

  test('a 400 for the schema is retried once without it', async () => {
    const sent = stubFetch([new Response('bad schema', { status: 400 }), okResponse('{}')])
    const result = await generateJson(env, 'gemini-2.5-flash', { system: 's', user: 'u' }, { op: 'op', schema })
    expect(result.text).toBe('{}')
    expect(sent).toHaveLength(2)
    expect(sent[1].body.generationConfig).toEqual({ responseMimeType: 'application/json' })
    expect(sent[1].body.systemInstruction).toEqual({ parts: [{ text: 's' }] })
  })

  test('a second 400 is not retried again', async () => {
    const sent = stubFetch([new Response('bad schema', { status: 400 }), new Response('still bad', { status: 400 })])
    await expect(
      generateJson(env, 'gemini-2.5-flash', { system: 's', user: 'u' }, { op: 'op', schema })
    ).rejects.toThrow('Gemini op failed: 400 still bad')
    expect(sent).toHaveLength(2)
  })

  test('a 400 without a schema is not retried', async () => {
    const sent = stubFetch([new Response('bad request', { status: 400 })])
    await expect(generateJson(env, 'gemini-2.5-flash', { system: 's', user: 'u' }, { op: 'op' })).rejects.toThrow(
      'Gemini op failed: 400 bad request'
    )
    expect(sent).toHaveLength(1)
  })

  test('other statuses are not retried', async () => {
    const sent = stubFetch([new Response('overloaded', { status: 503 })])
    await expect(
      generateJson(env, 'gemini-2.5-flash', { system: 's', user: 'u' }, { op: 'op', schema })
    ).rejects.toThrow('Gemini op failed: 503 overloaded')
    expect(sent).toHaveLength(1)
  })

  test('an empty response throws with the finish reason', async () => {
    stubFetch([new Response(JSON.stringify({ candidates: [{ finishReason: 'SAFETY' }] }), { status: 200 })])
    await expect(generateJson(env, 'gemini-2.5-flash', { system: 's', user: 'u' }, { op: 'op' })).rejects.toThrow(
      'Gemini returned empty op response (finishReason=SAFETY)'
    )
  })

  test('timeoutMs aborts a hanging request', async () => {
    globalThis.fetch = Object.assign(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
      { preconnect: realFetch.preconnect }
    )
    await expect(
      generateJson(env, 'gemini-2.5-flash', { system: 's', user: 'u' }, { op: 'op', timeoutMs: 20 })
    ).rejects.toThrow('Gemini op の応答が 0 秒以内に終わらなかったため中断しました')
  })
})
