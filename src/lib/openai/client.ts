import type { Env } from '@/lib/db'
import { openaiConfig } from './models'
import {
  buildRequestBody,
  endpointPath,
  type OpenAIFormat,
  parseResult,
  parseStreamChunk,
  type StreamTarget,
  stripCodeFence,
  type UsageCounts
} from './protocol'

function requireConfig(env: Env) {
  const config = openaiConfig(env)
  if (config === null) {
    throw new Error(
      'OpenAI 互換 API が設定されていません (サーバーの OPENAI_BASE_URL と OPENAI_API_KEY を設定してください)'
    )
  }
  return config
}

function headers(apiKey: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }
}

// 本文のストリーム生成。ref は DB に保存される `openai:<id>` 形式、id は上流に送るモデル名。
// temperature は送らない (推論系のモデルが指定を拒否することがあるため)。
export function openaiStreamTarget(env: Env, ref: string, id: string, prompt: string): StreamTarget {
  const config = requireConfig(env)
  return {
    url: `${config.baseUrl}${endpointPath(config.format)}`,
    headers: headers(config.apiKey),
    body: buildRequestBody(config.format, { model: id, prompt, stream: true, json: false }),
    label: 'OpenAI',
    parse: (chunk) => parseStreamChunk(config.format, chunk, ref)
  }
}

// 章立て用: JSON を 1 回で受け取る。コードフェンスで囲まれていても外して返す。
// ストリームと同じく ref は保存値の形 (`openai:<id>`、usage.model に入れる)、id は上流に送るモデル名。
export async function openaiCompleteJsonText(
  env: Env,
  ref: string,
  id: string,
  prompt: string,
  op: string
): Promise<{ text: string; usage: UsageCounts | undefined }> {
  const config = requireConfig(env)
  const format: OpenAIFormat = config.format
  const res = await fetch(`${config.baseUrl}${endpointPath(format)}`, {
    method: 'POST',
    headers: headers(config.apiKey),
    body: JSON.stringify(buildRequestBody(format, { model: id, prompt, stream: false, json: true }))
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`OpenAI ${op} failed: ${res.status} ${err}`)
  }

  const parsed = parseResult(format, await res.json(), ref)
  if (parsed.error !== undefined) throw new Error(`OpenAI ${op} failed: ${parsed.error}`)
  if (parsed.text.length === 0) {
    const reason = parsed.finishReason === undefined ? 'unknown' : parsed.finishReason
    throw new Error(`OpenAI returned empty ${op} response (finishReason=${reason})`)
  }
  return { text: stripCodeFence(parsed.text), usage: parsed.usage }
}
