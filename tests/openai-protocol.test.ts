import { describe, expect, test } from 'bun:test'
import {
  buildRequestBody,
  endpointPath,
  parseChatChunk,
  parseResponsesEvent,
  parseResult,
  parseStreamChunk,
  resolveFormat,
  stripCodeFence
} from '@/lib/openai/protocol'

describe('format selection', () => {
  test('defaults to chat completions', () => {
    expect(resolveFormat(undefined)).toBe('chat')
    expect(resolveFormat('chat')).toBe('chat')
    expect(resolveFormat('nonsense')).toBe('chat')
  })
  test('responses is opt-in', () => {
    expect(resolveFormat('responses')).toBe('responses')
  })
  test('endpoint paths', () => {
    expect(endpointPath('chat')).toBe('/chat/completions')
    expect(endpointPath('responses')).toBe('/responses')
  })
})

describe('buildRequestBody', () => {
  test('chat streaming asks for usage and sends no temperature', () => {
    const body = buildRequestBody('chat', { model: 'm', prompt: 'p', stream: true, json: false })
    expect(body).toEqual({
      model: 'm',
      messages: [{ role: 'user', content: 'p' }],
      stream: true,
      stream_options: { include_usage: true }
    })
  })
  test('chat json mode', () => {
    const body = buildRequestBody('chat', { model: 'm', prompt: 'p', stream: false, json: true })
    expect(body).toEqual({
      model: 'm',
      messages: [{ role: 'user', content: 'p' }],
      stream: false,
      response_format: { type: 'json_object' }
    })
  })
  test('responses streaming', () => {
    const body = buildRequestBody('responses', { model: 'm', prompt: 'p', stream: true, json: false })
    expect(body).toEqual({ model: 'm', input: 'p', stream: true })
  })
  test('responses json mode', () => {
    const body = buildRequestBody('responses', { model: 'm', prompt: 'p', stream: false, json: true })
    expect(body).toEqual({ model: 'm', input: 'p', stream: false, text: { format: { type: 'json_object' } } })
  })
})

describe('chat completions stream', () => {
  test('delta content becomes text', () => {
    const chunk = { choices: [{ delta: { content: '吾輩は' }, finish_reason: null }] }
    expect(parseChatChunk(chunk, 'm')).toEqual({ text: '吾輩は', usage: undefined, finishReason: undefined })
  })
  test('thinking text is not part of the body', () => {
    const chunk = { choices: [{ delta: { reasoning_content: 'hmm', content: null }, finish_reason: null }] }
    expect(parseChatChunk(chunk, 'm').text).toBe('')
  })
  test('finish reasons use the Gemini vocabulary', () => {
    const reason = (value: string) => parseChatChunk({ choices: [{ delta: {}, finish_reason: value }] }, 'm').finishReason
    expect(reason('stop')).toBe('STOP')
    expect(reason('length')).toBe('MAX_TOKENS')
    expect(reason('content_filter')).toBe('SAFETY')
    expect(reason('tool_calls')).toBe('OTHER')
  })
  test('usage arrives on the last chunk with empty choices', () => {
    const chunk = { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } }
    const parsed = parseChatChunk(chunk, 'm')
    expect(parsed.text).toBe('')
    expect(parsed.usage).toEqual({ model: 'm', promptTokens: 120, outputTokens: 30, totalTokens: 150 })
  })
  test('usage: null on regular chunks is ignored', () => {
    const chunk = { choices: [{ delta: { content: 'a' } }], usage: null }
    expect(parseChatChunk(chunk, 'm').usage).toBeUndefined()
  })
  test('total is derived when missing', () => {
    const chunk = { choices: [], usage: { prompt_tokens: 5, completion_tokens: 7 } }
    expect(parseChatChunk(chunk, 'm').usage?.totalTokens).toBe(12)
  })
  test('error chunk is surfaced', () => {
    expect(parseChatChunk({ error: { message: 'quota exceeded' } }, 'm').error).toBe('quota exceeded')
  })
  test('garbage does not throw', () => {
    expect(parseChatChunk('x', 'm').text).toBe('')
    expect(parseChatChunk(null, 'm').text).toBe('')
    expect(parseChatChunk({ choices: 'nope' }, 'm').text).toBe('')
  })
})

describe('responses stream', () => {
  test('output_text.delta becomes text', () => {
    expect(parseResponsesEvent({ type: 'response.output_text.delta', delta: '夜が' }, 'm').text).toBe('夜が')
  })
  test('reasoning summaries are dropped', () => {
    expect(parseResponsesEvent({ type: 'response.reasoning_summary_text.delta', delta: 'thinking' }, 'm').text).toBe('')
  })
  test('completed carries usage and STOP', () => {
    const event = {
      type: 'response.completed',
      response: { status: 'completed', usage: { input_tokens: 200, output_tokens: 80, total_tokens: 280 } }
    }
    const parsed = parseResponsesEvent(event, 'm')
    expect(parsed.finishReason).toBe('STOP')
    expect(parsed.usage).toEqual({ model: 'm', promptTokens: 200, outputTokens: 80, totalTokens: 280 })
  })
  test('incomplete maps to the Gemini vocabulary', () => {
    const event = {
      type: 'response.incomplete',
      response: { incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 1, output_tokens: 2 } }
    }
    const parsed = parseResponsesEvent(event, 'm')
    expect(parsed.finishReason).toBe('MAX_TOKENS')
    expect(parsed.usage?.totalTokens).toBe(3)
  })
  test('content_filter maps to SAFETY', () => {
    const event = { type: 'response.incomplete', response: { incomplete_details: { reason: 'content_filter' } } }
    expect(parseResponsesEvent(event, 'm').finishReason).toBe('SAFETY')
  })
  test('failed and error events are surfaced', () => {
    expect(parseResponsesEvent({ type: 'response.failed', response: { error: { message: 'boom' } } }, 'm').error).toBe('boom')
    expect(parseResponsesEvent({ type: 'error', message: 'bad key' }, 'm').error).toBe('bad key')
  })
  test('unrelated events are ignored', () => {
    expect(parseResponsesEvent({ type: 'response.created', response: {} }, 'm')).toEqual({ text: '' })
  })
})

describe('parseStreamChunk dispatch', () => {
  test('picks the parser by format', () => {
    const chat = { choices: [{ delta: { content: 'c' } }] }
    const responses = { type: 'response.output_text.delta', delta: 'r' }
    expect(parseStreamChunk('chat', chat, 'm').text).toBe('c')
    expect(parseStreamChunk('responses', responses, 'm').text).toBe('r')
    expect(parseStreamChunk('chat', responses, 'm').text).toBe('')
  })
})

describe('parseResult (non-stream)', () => {
  test('chat message content', () => {
    const body = {
      choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
    }
    const parsed = parseResult('chat', body, 'm')
    expect(parsed.text).toBe('{"a":1}')
    expect(parsed.finishReason).toBe('STOP')
    expect(parsed.usage?.totalTokens).toBe(7)
  })
  test('responses joins output_text parts of message items only', () => {
    const body = {
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', content: [{ type: 'output_text', text: '{"a":' }, { type: 'output_text', text: '1}' }] }
      ],
      usage: { input_tokens: 9, output_tokens: 1 }
    }
    const parsed = parseResult('responses', body, 'm')
    expect(parsed.text).toBe('{"a":1}')
    expect(parsed.finishReason).toBe('STOP')
  })
  test('responses incomplete', () => {
    const body = { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }
    expect(parseResult('responses', body, 'm').finishReason).toBe('MAX_TOKENS')
  })
  test('error body is surfaced', () => {
    expect(parseResult('chat', { error: { message: 'no such model' } }, 'm').error).toBe('no such model')
  })
  test('empty chat body yields empty text', () => {
    expect(parseResult('chat', { choices: [] }, 'm').text).toBe('')
  })
})

describe('stripCodeFence', () => {
  test('removes a json fence', () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })
  test('removes a bare fence', () => {
    expect(stripCodeFence('```\n[1,2]\n```')).toBe('[1,2]')
  })
  test('leaves plain JSON alone', () => {
    expect(stripCodeFence('  {"a":1} ')).toBe('{"a":1}')
  })
})
