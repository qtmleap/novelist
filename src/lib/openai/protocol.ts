// OpenAI 互換 API の通信形式 (chat completions / responses) だけを扱う純粋なモジュール。
// ネットワークも Workers の env も触らないので、bun test でそのまま検証できる。
// 呼び出し側は Gemini と同じ「テキスト + usage + 終了理由」の形で受け取る。

export type OpenAIFormat = 'chat' | 'responses'

export type UsageCounts = {
  model: string
  promptTokens: number
  outputTokens: number
  totalTokens: number
}

// ストリームの 1 チャンク、または非ストリーム応答 1 件を解釈した結果。
// finishReason は Gemini の語彙 (STOP / MAX_TOKENS / SAFETY / OTHER) に揃える。
// そうすると chapter-gen-do.ts の打ち切り判定とエラー文をそのまま使える。
export type ParsedChunk = {
  text: string
  usage?: UsageCounts
  finishReason?: string
  blockReason?: string
  error?: string
}

// ストリーミング呼び出し 1 回分の「送り先と読み方」。Gemini も OpenAI 互換も同じ形で返すので、
// 受信ループ (無応答の監視・再接続・本文の書き出し) は 1 つで済む。
export type StreamTarget = {
  url: string
  headers: Record<string, string>
  body: unknown
  // エラー文の先頭に付ける提供元の名前。
  label: string
  parse: (chunk: unknown) => ParsedChunk
}

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function resolveFormat(raw: string | undefined): OpenAIFormat {
  return raw === 'responses' ? 'responses' : 'chat'
}

export function endpointPath(format: OpenAIFormat): string {
  return format === 'responses' ? '/responses' : '/chat/completions'
}

type RequestOptions = {
  model: string
  prompt: string
  stream: boolean
  // true なら JSON オブジェクトだけを返すよう要求する (章立て用)。
  json: boolean
}

// temperature は送らない。推論系のモデルは指定を拒否して 400 を返すことがあり、
// 小説生成ではサーバー既定の値でも困らないため。
export function buildRequestBody(format: OpenAIFormat, options: RequestOptions): Json {
  const { model, prompt, stream, json } = options
  if (format === 'responses') {
    return {
      model,
      input: prompt,
      stream,
      ...(json ? { text: { format: { type: 'json_object' } } } : {})
    }
  }
  return {
    model,
    messages: [{ role: 'user', content: prompt }],
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(json ? { response_format: { type: 'json_object' } } : {})
  }
}

function errorMessage(error: unknown): string {
  const message = asString(field(error, 'message'))
  if (message !== undefined) return message
  return typeof error === 'string' ? error : JSON.stringify(error)
}

// chat completions の finish_reason を Gemini の語彙に直す。null (まだ終わっていない) は undefined。
function mapChatFinishReason(reason: unknown): string | undefined {
  if (typeof reason !== 'string') return undefined
  if (reason === 'stop') return 'STOP'
  if (reason === 'length') return 'MAX_TOKENS'
  if (reason === 'content_filter') return 'SAFETY'
  if (reason === 'tool_calls' || reason === 'function_call') return 'OTHER'
  return reason.toUpperCase()
}

// responses の incomplete_details.reason を Gemini の語彙に直す。
function mapIncompleteReason(reason: unknown): string {
  if (reason === 'max_output_tokens') return 'MAX_TOKENS'
  if (reason === 'content_filter') return 'SAFETY'
  return typeof reason === 'string' ? reason.toUpperCase() : 'OTHER'
}

function chatUsage(value: unknown, model: string): UsageCounts | undefined {
  const promptTokens = asNumber(field(value, 'prompt_tokens'))
  const outputTokens = asNumber(field(value, 'completion_tokens'))
  if (promptTokens === undefined || outputTokens === undefined) return undefined
  const total = asNumber(field(value, 'total_tokens'))
  return { model, promptTokens, outputTokens, totalTokens: total === undefined ? promptTokens + outputTokens : total }
}

function responsesUsage(value: unknown, model: string): UsageCounts | undefined {
  const promptTokens = asNumber(field(value, 'input_tokens'))
  const outputTokens = asNumber(field(value, 'output_tokens'))
  if (promptTokens === undefined || outputTokens === undefined) return undefined
  const total = asNumber(field(value, 'total_tokens'))
  return { model, promptTokens, outputTokens, totalTokens: total === undefined ? promptTokens + outputTokens : total }
}

function firstChoice(chunk: unknown): unknown {
  const choices = field(chunk, 'choices')
  return Array.isArray(choices) ? choices[0] : undefined
}

// chat completions のストリーム 1 チャンク。
// 本文は choices[0].delta.content。usage は include_usage 指定時、choices が空の最終チャンクに載る。
// reasoning_content などの思考テキストは本文に含めない。
export function parseChatChunk(chunk: unknown, model: string): ParsedChunk {
  const error = field(chunk, 'error')
  if (error !== undefined && error !== null) return { text: '', error: errorMessage(error) }
  const choice = firstChoice(chunk)
  const content = asString(field(field(choice, 'delta'), 'content'))
  return {
    text: content === undefined ? '' : content,
    usage: chatUsage(field(chunk, 'usage'), model),
    finishReason: mapChatFinishReason(field(choice, 'finish_reason'))
  }
}

// responses のストリーム 1 イベント (data 行の JSON)。種別は type に入っている。
// 本文は response.output_text.delta だけ。思考の要約 (response.reasoning_*) は捨てる。
export function parseResponsesEvent(chunk: unknown, model: string): ParsedChunk {
  const type = asString(field(chunk, 'type'))
  if (type === 'response.output_text.delta') {
    const delta = asString(field(chunk, 'delta'))
    return { text: delta === undefined ? '' : delta }
  }
  if (type === 'error') return { text: '', error: errorMessage(chunk) }
  if (type === 'response.failed') {
    const error = field(field(chunk, 'response'), 'error')
    return { text: '', error: error === undefined || error === null ? 'response.failed' : errorMessage(error) }
  }
  if (type === 'response.completed' || type === 'response.incomplete') {
    const response = field(chunk, 'response')
    const usage = responsesUsage(field(response, 'usage'), model)
    const finishReason =
      type === 'response.completed'
        ? 'STOP'
        : mapIncompleteReason(field(field(response, 'incomplete_details'), 'reason'))
    return { text: '', usage, finishReason }
  }
  return { text: '' }
}

export function parseStreamChunk(format: OpenAIFormat, chunk: unknown, model: string): ParsedChunk {
  return format === 'responses' ? parseResponsesEvent(chunk, model) : parseChatChunk(chunk, model)
}

// 非ストリーム応答 (章立て用)。形式ごとに本文を取り出す。
export function parseResult(format: OpenAIFormat, body: unknown, model: string): ParsedChunk {
  const error = field(body, 'error')
  if (error !== undefined && error !== null) return { text: '', error: errorMessage(error) }

  if (format === 'responses') {
    const output = field(body, 'output')
    const items = Array.isArray(output) ? output : []
    const text = items
      .filter((item) => field(item, 'type') === 'message')
      .flatMap((item) => {
        const content = field(item, 'content')
        return Array.isArray(content) ? content : []
      })
      .filter((part) => field(part, 'type') === 'output_text')
      .map((part) => asString(field(part, 'text')))
      .filter((part): part is string => part !== undefined)
      .join('')
    const status = asString(field(body, 'status'))
    const finishReason =
      status === 'incomplete' ? mapIncompleteReason(field(field(body, 'incomplete_details'), 'reason')) : 'STOP'
    return { text, usage: responsesUsage(field(body, 'usage'), model), finishReason }
  }

  const choice = firstChoice(body)
  const content = asString(field(field(choice, 'message'), 'content'))
  return {
    text: content === undefined ? '' : content,
    usage: chatUsage(field(body, 'usage'), model),
    finishReason: mapChatFinishReason(field(choice, 'finish_reason'))
  }
}

// モデルが JSON を ```json ... ``` で囲んで返すことがあるので、囲いを外す。
export function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const match = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(trimmed)
  return match === null ? trimmed : match[1].trim()
}
