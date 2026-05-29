import { DurableObject } from 'cloudflare:workers'
import { PrismaD1 } from '@prisma/adapter-d1'
import { PrismaClient } from '@/generated/prisma/client'
import type { Env } from '@/lib/db'
import {
  type CastMember,
  type CastRelation,
  computeCostUsd,
  type StreamChapterUsage,
  streamChapter
} from '@/lib/gemini/client'
import { saveChapter } from '@/lib/novel/repository'
import type { GeminiModel, Outline } from '@/schemas/novel.dto'

// Gemini の finishReason を人向けの日本語メッセージに変換する。
// 'STOP' 以外がここに届く前提なので 'STOP' は扱わない。
function truncationMessage(finishReason: string): string {
  if (finishReason === 'MAX_TOKENS') {
    return '生成が出力トークン上限で打ち切られました。途中までの本文は保存されています。もう一度再生成するか、章を分割してから生成してください。'
  }
  if (finishReason === 'SAFETY') {
    return 'Gemini のセーフティ判定で生成が打ち切られました。途中までの本文は保存されています。プロンプトや設定をやや穏当な内容に調整して再生成してください。'
  }
  if (finishReason === 'RECITATION') {
    return 'Gemini が引用拒否で停止しました。途中までの本文は保存されています。固有名詞や台詞をプロンプトから減らして再生成してください。'
  }
  return `生成が途中で打ち切られました (理由: ${finishReason})。途中までの本文は保存されています。`
}

// DO 起動時に worker から渡されるペイロード。プロンプト合成に必要な小説 + outline 情報を全部含む
// (DO 側で D1 を読みに行かない: 起動時の novel スナップショットを使うほうが冪等で扱いやすい)。
export type StartChapterGenPayload = {
  novelId: string
  chapterNumber: number
  chapterTitle: string
  targetChars: number
  model?: GeminiModel
  novel: {
    title: string
    genre: string
    characters: string
    setting: string
    num_chapters: number
    notes: string
  }
  outline: Outline
  previousChapters: Array<{ chapter_number: number; content: string }>
  style: {
    pov: string
    tone: string
    age_rating?: string
    ending?: string
    viewpointChar?: { name: string; first_person: string }
  }
  cast?: CastMember[]
  relations?: CastRelation[]
}

type Phase = 'idle' | 'streaming' | 'done' | 'error'

type Subscriber = {
  writer: WritableStreamDefaultWriter<Uint8Array>
}

// 生成中に進捗が止まったと見なすしきい値 (ミリ秒)。DO の eviction や Gemini の sub-request kill で
// run() が静かに死ぬケースを救う: 進捗がこの時間以上更新されていなければ stale とみなして再起動を許可する。
const STALE_STREAMING_MS = 60_000

export class ChapterGenerationDO extends DurableObject<Env> {
  private subscribers: Set<Subscriber> = new Set()

  // 永続化される状態 (DO がハイバネートしても保持)。
  private phase: Phase = 'idle'
  private buffer = ''
  private errMsg: string | null = null
  private chapterId: string | null = null
  private chapterTitle: string | null = null
  // 最後に「進捗 (delta 受信や phase 遷移)」があった unix ms。stale 判定に使う。
  private lastProgressAt = 0

  // この DO がいま属している (novel, chapter) — start 時に決まる。再起動時に payload を覚えていないと
  // run() を完走できないので、payload も storage に格納する。
  private payload: StartChapterGenPayload | null = null

  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
    void state.blockConcurrencyWhile(async () => {
      this.phase = (await state.storage.get<Phase>('phase')) ?? 'idle'
      this.buffer = (await state.storage.get<string>('buffer')) ?? ''
      this.errMsg = (await state.storage.get<string | null>('errMsg')) ?? null
      this.chapterId = (await state.storage.get<string | null>('chapterId')) ?? null
      this.chapterTitle = (await state.storage.get<string | null>('chapterTitle')) ?? null
      this.payload = (await state.storage.get<StartChapterGenPayload>('payload')) ?? null
      this.lastProgressAt = (await state.storage.get<number>('lastProgressAt')) ?? 0
    })
  }

  // 生成開始 (idempotent: streaming 中なら no-op、done なら新しい生成で上書き)
  async start(payload: StartChapterGenPayload): Promise<{ status: 'started' | 'already_streaming' }> {
    if (this.phase === 'streaming') {
      // DO が evict されると run() の Promise が静かに失われ、phase だけ 'streaming' のまま残ることがある。
      // 一定時間進捗が無いものは stale 扱いで再起動させる。生きてる run() がたまたま残っていた場合は
      // run() 側が新しい storage.put で上書きされても気付けないが、結局そのまま死ぬので問題なし。
      const sinceProgress = Date.now() - this.lastProgressAt
      if (sinceProgress < STALE_STREAMING_MS) {
        return { status: 'already_streaming' }
      }
    }
    this.phase = 'streaming'
    this.buffer = ''
    this.errMsg = null
    this.chapterId = null
    this.chapterTitle = null
    this.payload = payload
    this.lastProgressAt = Date.now()
    await this.persistAll()
    this.ctx.waitUntil(this.run())
    return { status: 'started' }
  }

  // SSE で接続する。現バッファ replay → 以降の差分を fan-out。
  async openStream(): Promise<Response> {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    const sub: Subscriber = { writer }
    this.subscribers.add(sub)

    const encoder = new TextEncoder()
    const send = async (data: unknown) => {
      try {
        await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      } catch {
        this.subscribers.delete(sub)
      }
    }

    // 現バッファをまとめて 1 イベントで replay
    if (this.buffer.length > 0) await send({ delta: this.buffer })

    // 既に終わっている場合は最終イベントを送って閉じる
    if (this.phase === 'done') {
      await send({ done: true, chapterId: this.chapterId, title: this.chapterTitle })
      try {
        await writer.close()
      } catch {
        /* already closed */
      }
      this.subscribers.delete(sub)
    } else if (this.phase === 'error') {
      await send({ error: this.errMsg ?? 'unknown_error' })
      try {
        await writer.close()
      } catch {
        /* already closed */
      }
      this.subscribers.delete(sub)
    }

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no'
      }
    })
  }

  // 現在状態の照会 (debug 用)
  async status(): Promise<{
    phase: Phase
    bufferLen: number
    chapterId: string | null
    title: string | null
    error: string | null
  }> {
    return {
      phase: this.phase,
      bufferLen: this.buffer.length,
      chapterId: this.chapterId,
      title: this.chapterTitle,
      error: this.errMsg
    }
  }

  private async run() {
    const encoder = new TextEncoder()
    const payload = this.payload
    if (!payload) {
      await this.transitionError('payload_missing')
      return
    }
    try {
      const result = streamChapter(this.env, {
        novel: payload.novel,
        outline: payload.outline,
        chapterNumber: payload.chapterNumber,
        previousChapters: payload.previousChapters,
        targetChars: payload.targetChars,
        style: payload.style,
        cast: payload.cast,
        relations: payload.relations,
        model: payload.model
      })

      const decoder = new TextDecoder()
      for await (const chunk of result.stream) {
        const delta = decoder.decode(chunk, { stream: true })
        if (!delta) continue
        this.buffer += delta
        // バッファは細かく書きすぎると I/O コスト高なので 256 文字ごとに flush + 完了時に flush
        if (this.buffer.length % 256 < delta.length) {
          this.lastProgressAt = Date.now()
          await this.ctx.storage.put('buffer', this.buffer)
          await this.ctx.storage.put('lastProgressAt', this.lastProgressAt)
        }
        const event = encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`)
        await this.fanout(event)
      }

      // 完了時 buffer flush
      await this.ctx.storage.put('buffer', this.buffer)

      // Gemini の finishReason を取得 (stream 終了時に resolve される)。
      // 'STOP' = 正常完了。'MAX_TOKENS' / 'SAFETY' / 'RECITATION' / 'OTHER' は途中打ち切り。
      let usage: StreamChapterUsage | undefined
      try {
        usage = await result.usage
      } catch {
        usage = undefined
      }
      const finishReason = usage === undefined ? 'STOP' : usage.finishReason
      const truncated = finishReason !== 'STOP'

      // D1 へ章本文を保存 (途中打ち切りでも残しておいて、UI 側で再生成判断できるようにする)
      const prisma = this.makePrisma()
      let saved: { id: string }
      try {
        saved = await saveChapter(prisma, payload.novelId, payload.chapterNumber, this.buffer, payload.chapterTitle)
      } catch (e) {
        await prisma.$disconnect()
        const msg = e instanceof Error ? e.message : String(e)
        await this.transitionError(`save_failed: ${msg}`)
        return
      }

      // コスト記録 (best-effort)
      if (usage) {
        try {
          const costUsd = computeCostUsd(usage.model, usage.promptTokens, usage.outputTokens)
          await prisma.chapterGenerationCost.create({
            data: {
              novel_id: payload.novelId,
              chapter_number: payload.chapterNumber,
              model: usage.model,
              prompt_tokens: usage.promptTokens,
              output_tokens: usage.outputTokens,
              cost_usd: costUsd
            }
          })
        } catch {
          /* best-effort */
        }
      }
      await prisma.$disconnect()

      this.chapterId = saved.id
      this.chapterTitle = payload.chapterTitle

      if (truncated) {
        // 途中打ち切り: 部分本文は D1 に保存済み。UI には error として通知し、ユーザーが再生成を判断できるようにする。
        this.phase = 'error'
        this.errMsg = truncationMessage(finishReason)
        await this.persistAll()
        const errEvent = encoder.encode(`data: ${JSON.stringify({ error: this.errMsg })}\n\n`)
        await this.fanout(errEvent)
        await this.closeAll()
        return
      }

      this.phase = 'done'
      await this.persistAll()

      const event = encoder.encode(
        `data: ${JSON.stringify({ done: true, chapterId: saved.id, title: payload.chapterTitle })}\n\n`
      )
      await this.fanout(event)
      await this.closeAll()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await this.transitionError(msg)
    }
  }

  private async transitionError(msg: string) {
    this.phase = 'error'
    this.errMsg = msg
    await this.persistAll()
    const encoder = new TextEncoder()
    const event = encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`)
    await this.fanout(event)
    await this.closeAll()
  }

  private async fanout(event: Uint8Array) {
    const dead: Subscriber[] = []
    for (const sub of this.subscribers) {
      try {
        await sub.writer.write(event)
      } catch {
        dead.push(sub)
      }
    }
    for (const d of dead) this.subscribers.delete(d)
  }

  private async closeAll() {
    for (const sub of this.subscribers) {
      try {
        await sub.writer.close()
      } catch {
        /* already closed */
      }
    }
    this.subscribers.clear()
  }

  private async persistAll() {
    await Promise.all([
      this.ctx.storage.put('phase', this.phase),
      this.ctx.storage.put('buffer', this.buffer),
      this.ctx.storage.put('errMsg', this.errMsg),
      this.ctx.storage.put('chapterId', this.chapterId),
      this.ctx.storage.put('chapterTitle', this.chapterTitle),
      this.ctx.storage.put('payload', this.payload),
      this.ctx.storage.put('lastProgressAt', this.lastProgressAt)
    ])
  }

  private makePrisma(): PrismaClient {
    const adapter = new PrismaD1(this.env.DB)
    return new PrismaClient({ adapter })
  }
}
