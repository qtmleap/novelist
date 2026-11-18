import type { Env } from '@/lib/db'
import type { Prompt } from '@/lib/novel/prompts'
import { openaiConfig } from './models'
import {
  buildRequestBody,
  endpointPath,
  type OpenAIFormat,
  parseResult,
  parseStreamChunk,
  type StreamTarget,
  stripCodeFence,
  timeoutMessage,
  timeoutSignal,
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
export function openaiStreamTarget(env: Env, ref: string, id: string, prompt: Prompt): StreamTarget {
  const config = requireConfig(env)
  return {
    url: `${config.baseUrl}${endpointPath(config.format)}`,
    headers: headers(config.apiKey),
    body: buildRequestBody(config.format, {
      model: id,
      system: prompt.system,
      user: prompt.user,
      stream: true,
      json: false
    }),
    label: 'OpenAI',
    parse: (chunk) => parseStreamChunk(config.format, chunk, ref)
  }
}

export type OpenAIJsonOptions = {
  // エラー文に出す呼び出しの名前。
  op: string
  // 応答を待つ上限 (ミリ秒)。無ければ打ち切らない。
  timeoutMs?: number
}

// 章立て用: JSON を 1 回で受け取る。コードフェンスで囲まれていても外して返す。
// ストリームと同じく ref は保存値の形 (`openai:<id>`、usage.model に入れる)、id は上流に送るモデル名。
// 構造化出力の schema は送らない (互換サーバーごとに対応がまちまちなので json_object に留め、検証はコード側で行う)。
export async function openaiCompleteJsonText(
  env: Env,
  ref: string,
  id: string,
  prompt: Prompt,
  options: OpenAIJsonOptions
): Promise<{ text: string; usage: UsageCounts | undefined }> {
  const { op, timeoutMs } = options
  const config = requireConfig(env)
  const format: OpenAIFormat = config.format
  const signal = timeoutSignal(timeoutMs)
  try {
    const res = await fetch(`${config.baseUrl}${endpointPath(format)}`, {
      method: 'POST',
      headers: headers(config.apiKey),
      body: JSON.stringify(
        buildRequestBody(format, { model: id, system: prompt.system, user: prompt.user, stream: false, json: true })
      ),
      signal
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
  } catch (e) {
    if (signal?.aborted === true && timeoutMs !== undefined) throw new Error(timeoutMessage(`OpenAI ${op}`, timeoutMs))
    throw e
  }
}
