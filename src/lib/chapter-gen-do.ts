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
import { buildChapterPayload } from '@/lib/novel/chapter-payload'
import { saveChapter } from '@/lib/novel/repository'
import type { GeminiModel, Outline } from '@/schemas/novel.dto'
import { GeminiModelSchema } from '@/schemas/novel.dto'

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

// 出力が 0 文字だったときの原因別メッセージ。blockReason (プロンプト拒否) を最優先で示し、
// それが無ければ finishReason、どちらも無ければ汎用文を返す。
function emptyOutputMessage(blockReason: string | undefined, finishReason: string | undefined): string {
  if (blockReason === 'PROHIBITED_CONTENT') {
    return 'Gemini がプロンプトを拒否しました (PROHIBITED_CONTENT)。登場人物の年齢設定 (18 歳未満) と性的描写の組み合わせなど、Google が一律で禁じている内容に該当している可能性があります。年齢を 18 歳以上にするか、年齢指定を R15/全年齢 に変更して再生成してください。'
  }
  if (blockReason === 'SAFETY') {
    return 'Gemini のセーフティ判定でプロンプトが拒否されました (SAFETY)。設定や備考の表現をやや穏当にして再生成してください。'
  }
  if (blockReason !== undefined) {
    return `Gemini がプロンプトを拒否しました (${blockReason})。設定内容を見直して再生成してください。`
  }
  if (finishReason !== undefined && finishReason !== 'STOP') {
    return `生成テキストが空でした (finishReason: ${finishReason})。モデルを変更するか、設定を調整して再生成してください。`
  }
  return '生成テキストが空でした。Gemini がプロンプトをブロックしたか、思考モデルの出力がフィルタされた可能性があります。モデルを変更して再生成してください。'
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

// DO の keep-alive alarm の間隔。次の alarm までの時間。CF DO は active alarm が future にある間は
// hibernate されないので、streaming 中は alarm を chain して常に in-memory に保つ。
// SSE subscriber が居なくなっても (= ブラウザ閉じても) run() の Promise が evict で消えない。
const KEEPALIVE_INTERVAL_MS = 30_000

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
    // alarm を将来時刻に立てると DO が hibernate されない。run() が evict で消えても、
    // alarm() ハンドラ内で stale 判定 → 再起動できる。
    await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_INTERVAL_MS)
    this.ctx.waitUntil(this.run())
    return { status: 'started' }
  }

  // DO の keep-alive 兼 watchdog。CF DO はこのメソッドを setAlarm で予約した時刻に呼ぶ。
  // - phase=streaming が続いている限り次の alarm を立てて keep-alive
  // - 進捗が停止 (lastProgressAt が stale) してたら run() を再起動
  // - phase=done/error/idle なら alarm chain を終わらせて DO は自然に hibernate へ
  async alarm() {
    if (this.phase !== 'streaming') return
    const sinceProgress = Date.now() - this.lastProgressAt
    if (sinceProgress > STALE_STREAMING_MS && this.payload !== null) {
      // run() の Promise が消えているはずなので新しく起動。buffer 等は start() と同じ初期化を行う。
      this.buffer = ''
      this.errMsg = null
      this.chapterId = null
      this.chapterTitle = null
      this.lastProgressAt = Date.now()
      await this.persistAll()
      this.ctx.waitUntil(this.run())
    }
    await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_INTERVAL_MS)
  }

  // SSE で接続する。現バッファ replay → 以降の差分を fan-out。
  async openStream(): Promise<Response> {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    const sub: Subscriber = { writer }
    this.subscribers.add(sub)

    // 自己修復の二重起動防止だけは Response を返す前に同期実行する。lastProgressAt を
    // ここで先に更新しておくことで、ほぼ同時に複数 subscriber が来ても run() が二重起動しない。
    // (実際の run() 再開と storage への永続化は priming 側に委ねる)
    const needsSelfHeal =
      this.phase === 'streaming' && Date.now() - this.lastProgressAt > STALE_STREAMING_MS && this.payload !== null
    if (needsSelfHeal) {
      this.buffer = ''
      this.errMsg = null
      this.chapterId = null
      this.chapterTitle = null
      this.lastProgressAt = Date.now()
    }

    // 初期送出 (replay / 最終イベント / self-heal の再起動) は Response を返した後に
    // 走らせる。ここで await すると、readable がまだ消費されていない TransformStream に
    // 書き込むことになり、バックプレッシャで writer.write() が解決せず Response 自体が
    // 返らない (= ヘッダーすら出ずクライアントが永久にスピンする) ため。
    const prime = async () => {
      const encoder = new TextEncoder()
      const send = async (data: unknown) => {
        try {
          await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch {
          this.subscribers.delete(sub)
        }
      }
      const close = async () => {
        try {
          await writer.close()
        } catch {
          /* already closed */
        }
        this.subscribers.delete(sub)
      }

      // 現バッファをまとめて 1 イベントで replay
      if (this.buffer.length > 0) await send({ delta: this.buffer })

      // 既に終わっている場合は最終イベントを送って閉じる
      if (this.phase === 'done') {
        // phase=done のとき chapterTitle は run() が必ず設定して persistAll() で保存する。
        // null になるのは不変条件の破壊なので隠さず null のまま送り、
        // クライアント側の schema validation で onDone を呼ばずに表面化させる。
        await send({ done: true, chapterId: this.chapterId, title: this.chapterTitle })
        await close()
      } else if (this.phase === 'error') {
        await send({ error: this.errMsg ?? 'unknown_error' })
        await close()
      } else if (needsSelfHeal) {
        // 自己修復: phase=streaming だが進捗が STALE なものは、DO eviction で run() の
        // Promise が失われ alarm chain も途切れた死亡状態とみなす。run() を再起動して
        // alarm を貼り直す。
        await this.persistAll()
        await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_INTERVAL_MS)
        this.ctx.waitUntil(this.run())
      }
    }
    this.ctx.waitUntil(prime())

    return new Response(readable, {
      headers: {
        // charset=utf-8 を明示しないと、プロキシや devtools が Latin-1 と誤解して
        // 日本語の delta / error メッセージが文字化けする (例: 生成 → ç”Ÿæˆ)。
        'Content-Type': 'text/event-stream; charset=utf-8',
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
        model: payload.model,
        // thinking チャンクを含む全 Gemini チャンク受信時に lastProgressAt を更新する。
        // thinking フェーズ中はテキスト出力がないため result.stream に何も流れず、
        // lastProgressAt が更新されないまま alarm の stale 閾値を超えて誤再起動するのを防ぐ。
        onChunk: () => {
          this.lastProgressAt = Date.now()
        }
      })

      const decoder = new TextDecoder()
      for await (const chunk of result.stream) {
        const delta = decoder.decode(chunk, { stream: true })
        if (!delta) continue
        this.buffer += delta
        // lastProgressAt は delta ごとに更新する (in-memory のみ)。
        // alarm() の stale 判定や、後続の persist のタイミングに使う。
        this.lastProgressAt = Date.now()
        // バッファは細かく書きすぎると I/O コスト高なので 256 文字ごとに flush + 完了時に flush
        if (this.buffer.length % 256 < delta.length) {
          await this.ctx.storage.put('buffer', this.buffer)
          await this.ctx.storage.put('lastProgressAt', this.lastProgressAt)
        }
        const event = encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`)
        await this.fanout(event)
      }

      // stream: true で保持されたマルチバイト末尾バイトをフラッシュする。
      // 最後のチャンクが不完全な UTF-8 シーケンスで終わっていた場合、decode() を
      // stream オプションなしで呼ぶことで残りのバイトを文字列に確定させる。
      const tail = decoder.decode()
      if (tail) {
        this.buffer += tail
        const event = encoder.encode(`data: ${JSON.stringify({ delta: tail })}\n\n`)
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

      // バッファが空の場合はエラー扱い。Gemini がプロンプトを拒否したか、思考モデルが
      // 全出力を thinking チャンクとして送り extractText でフィルタされた可能性がある。
      // 0 文字で保存してしまうと UI に何も表示されないため、ユーザーが気づけるよう error にする。
      if (this.buffer.length === 0) {
        let blockReason: string | undefined
        try {
          blockReason = await result.blockReason
        } catch {
          blockReason = undefined
        }
        await this.transitionError(emptyOutputMessage(blockReason, usage?.finishReason))
        return
      }

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
        try {
          await this.failGenerationJob()
        } catch {
          // best-effort
        }
        const errEvent = encoder.encode(`data: ${JSON.stringify({ error: this.errMsg })}\n\n`)
        await this.fanout(errEvent)
        await this.closeAll()
        return
      }

      // Advance queue before notifying subscribers so client refetch sees updated job
      try {
        await this.advanceGenerationJob()
      } catch {
        // best-effort: don't fail chapter completion due to job advancement error
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
    // running の生成ジョブを stopped に落とす。これをしないと job が永遠に running のまま残り、
    // フロントは毎回ロード時にこの章を「生成中」とみなして購読 → 即エラー表示を繰り返す。
    try {
      await this.failGenerationJob()
    } catch {
      // best-effort: ジョブ更新の失敗で error 通知自体を止めない
    }
    const encoder = new TextEncoder()
    const event = encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`)
    await this.fanout(event)
    await this.closeAll()
  }

  // この novel の running ジョブを stopped にする (エラー/途中打ち切り時)。
  private async failGenerationJob(): Promise<void> {
    if (this.payload === null) return
    const prisma = this.makePrisma()
    try {
      await prisma.novelGenerationJob.updateMany({
        where: { novel_id: this.payload.novelId, status: 'running' },
        data: { status: 'stopped' }
      })
    } finally {
      await prisma.$disconnect()
    }
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

  private async advanceGenerationJob(): Promise<void> {
    if (!this.payload) return
    const prisma = this.makePrisma()
    try {
      const job = await prisma.novelGenerationJob.findUnique({
        where: { novel_id: this.payload.novelId }
      })
      if (!job || job.status !== 'running') return

      const pending: number[] = JSON.parse(job.pending)
      if (pending.length === 0 || pending[0] !== this.payload.chapterNumber) return

      const remaining = pending.slice(1)

      if (remaining.length === 0) {
        await prisma.novelGenerationJob.update({
          where: { novel_id: this.payload.novelId },
          data: { status: 'completed', pending: '[]', current: null }
        })
        return
      }

      const nextChapter = remaining[0]
      await prisma.novelGenerationJob.update({
        where: { novel_id: this.payload.novelId },
        data: { pending: JSON.stringify(remaining), current: nextChapter }
      })

      const nextPayload = await buildChapterPayload(
        prisma,
        this.payload.novelId,
        nextChapter,
        this.payload.model !== undefined ? this.payload.model : GeminiModelSchema.enum['gemini-2.5-flash']
      )
      if (!nextPayload) {
        await prisma.novelGenerationJob.update({
          where: { novel_id: this.payload.novelId },
          data: { status: 'stopped' }
        })
        return
      }

      const doId = this.env.CHAPTER_GEN.idFromName(`${this.payload.novelId}:${nextChapter}`)
      const stub = this.env.CHAPTER_GEN.get(doId)
      await stub.start(nextPayload)
    } finally {
      await prisma.$disconnect()
    }
  }

  private makePrisma(): PrismaClient {
    const adapter = new PrismaD1(this.env.DB)
    return new PrismaClient({ adapter })
  }
}
