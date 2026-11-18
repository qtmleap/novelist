import { DurableObject } from 'cloudflare:workers'
import { PrismaD1 } from '@prisma/adapter-d1'
import { z } from 'zod'
import { PrismaClient } from '@/generated/prisma/client'
import type { Env } from '@/lib/db'
import { type StreamChapterUsage, streamChapter } from '@/lib/gemini/client'
import {
  buildChapterContext,
  type ChapterGenPayload,
  extractAndSaveRecord,
  jsonCaller,
  loadRecordMaterials,
  type RecordMaterials,
  recordStageAction,
  restartState,
  resumePoint
} from '@/lib/novel/chapter-context'
import { recordGenerationCost } from '@/lib/novel/cost'
import { findChapterVersion, saveChapter } from '@/lib/novel/repository'
import type { ChapterStage, ModelRef } from '@/schemas/novel.dto'

// 続きの章を作るときに、ペイロードにモデルが無かった場合の最終フォールバック。
const DEFAULT_FALLBACK_MODEL: ModelRef = 'gemini-2.5-flash'

// 上流 (Gemini / OpenAI 互換) の finishReason を人向けの日本語メッセージに変換する。
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

// DO 起動時に worker から渡されるペイロード。小説の中身は持たず、文脈は run() の中で D1 から組み立てる
// (前の章を書き直した直後でも、生成を始めた時点の D1 の内容を使うため)。
// DO ストレージに残っている旧形式の payload (novel、outline などを含む) も、この 3 項目は同じ名前で持つので読める。
export type StartChapterGenPayload = ChapterGenPayload

// 本文を書き終えて保存した章。記録の抽出に使う。
// fresh は今回の run() で書いた場合だけ持つ (本文と抽出の材料がメモリにある)。再開のときは null で、D1 から読み直す。
type SavedChapter = {
  chapterId: string
  title: string
  fresh: { content: string; editorModel: ModelRef; materials: RecordMaterials } | null
}

// 記録の抽出に使う本文と材料。
type RecordJob = { title: string | null; content: string; editorModel: ModelRef; materials: RecordMaterials }

// DO に永続化する状態の schema。storage が空 (初回) のキーは .default() で初期値を当てる。
// ?? フォールバックを使わず、デフォルトをここに一元化する。
// errMsg / chapterTitle は .nonempty() を付けない: errMsg は e.message が空のことがあり、
// chapterTitle は outline 章タイトル (空文字制約なし) 由来で空になり得る。ここで空文字を弾くと
// 復元時に parse が throw して DO がクラッシュループするため、空文字も許容する。
const PersistedStateSchema = z.object({
  phase: z.enum(['idle', 'streaming', 'done', 'error']).default('idle'),
  buffer: z.string().default(''),
  errMsg: z.string().nullable().default(null),
  chapterId: z.string().nullable().default(null),
  chapterTitle: z.string().nullable().default(null),
  payload: z.custom<StartChapterGenPayload>().nullable().default(null),
  lastProgressAt: z.number().default(0)
})

type Phase = z.infer<typeof PersistedStateSchema>['phase']

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

  // run() が実行中か (in-memory のみ。DO インスタンス内での二重起動・buffer リセットのレース防止用)。
  // evict で消えても false に戻るだけなので永続化しない。
  private running = false

  // いまの段階 (SSE で画面に知らせる)。永続化しない: 再開した run() が、実際に入った段階を送り直す。
  private stage: ChapterStage | null = null

  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
    void state.blockConcurrencyWhile(async () => {
      const stored = await state.storage.list()
      const result = PersistedStateSchema.safeParse(Object.fromEntries(stored))
      // 自分で persistAll() が書いた storage なので schema 不一致は破損を意味する。
      // 黙って初期値に戻すと進行中の生成状態を握り潰すので、隠さず throw して表面化させる。
      if (!result.success) throw new Error(`corrupted DO state: ${result.error.message}`)
      const state_ = result.data
      this.phase = state_.phase
      this.buffer = state_.buffer
      this.errMsg = state_.errMsg
      this.chapterId = state_.chapterId
      this.chapterTitle = state_.chapterTitle
      this.payload = state_.payload
      this.lastProgressAt = state_.lastProgressAt
    })
  }

  // 生成開始 (idempotent: streaming 中なら no-op、done なら新しい生成で上書き)
  async start(payload: StartChapterGenPayload): Promise<{ status: 'started' | 'already_streaming' }> {
    // run() が生きている間は触らない (buffer リセットや二重 Gemini 呼び出しのレースを防ぐ)。
    if (this.running) return { status: 'already_streaming' }
    if (this.phase === 'streaming') {
      // DO が evict されると run() の Promise が静かに失われ、phase だけ 'streaming' のまま残ることがある。
      // 一定時間進捗が無いものは stale 扱いで再起動させる。生きてる run() がたまたま残っていた場合は
      // run() 側が新しい storage.put で上書きされても気付けないが、結局そのまま死ぬので問題なし。
      const sinceProgress = Date.now() - this.lastProgressAt
      if (sinceProgress < STALE_STREAMING_MS) {
        return { status: 'already_streaming' }
      }
    }
    // 利用者が新しく始めた生成は、保存済みの本文があっても常に最初から (再開ではない)。
    this.phase = 'streaming'
    this.buffer = ''
    this.errMsg = null
    this.chapterId = null
    this.chapterTitle = null
    this.stage = null
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
    if (sinceProgress > STALE_STREAMING_MS && this.payload !== null && !this.running) {
      // run() の Promise が消えているはずなので新しく起動。本文を保存済みなら記録の抽出から続ける。
      this.prepareRestart()
      await this.persistAll()
      this.ctx.waitUntil(this.run())
    }
    await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_INTERVAL_MS)
    // 本文が流れない段階 (資料の準備、記録の抽出) は数十秒〜数分続く。その間 SSE に何も流れないと、
    // 途中の経路が無通信の接続を切り、EventSource が再接続して本文の送り直しが起きる。
    // SSE のコメント行はクライアントの onmessage に届かないので、画面側は何もしなくてよい。
    // 段階の切り替わり ({ stage }) も通信になるので、そこでは別に送らない。
    // 判定と次の alarm の予約を先に済ませ、送信は待たない (購読者への書き込みが詰まっても、watchdog を止めないため)。
    this.ctx.waitUntil(this.fanout(new TextEncoder().encode(': keep-alive\n\n')).catch(() => undefined))
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
      this.phase === 'streaming' &&
      Date.now() - this.lastProgressAt > STALE_STREAMING_MS &&
      this.payload !== null &&
      !this.running
    if (needsSelfHeal) this.prepareRestart()

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

      // 生成中なら、いまの段階を先に知らせる (本文が流れていない段階でも、画面が止まって見えないように)。
      if (this.phase === 'streaming' && this.stage !== null) await send({ stage: this.stage })

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

  // 二重起動ガード。start()/alarm()/openStream() が並行して呼んでも run 本体は 1 つだけ走る。
  private async run() {
    if (this.running) return
    this.running = true
    try {
      await this.runInner()
    } finally {
      this.running = false
    }
  }

  private async runInner() {
    const payload = this.payload
    if (!payload) {
      await this.transitionError('payload_missing')
      return
    }
    try {
      // 本文を保存済み (止まった run() の再開) なら、記録の抽出から続ける。
      const resumed = resumePoint({ chapterId: this.chapterId, chapterTitle: this.chapterTitle })
      const saved: SavedChapter | null =
        resumed !== null ? { ...resumed, fresh: null } : await this.writeChapter(payload)
      // 書けなかった (error に遷移済み)、または打ち切りで error にした
      if (saved === null) return

      const recorded = await this.recordChapter(payload, saved)
      if (recorded === 'missing') {
        await this.transitionError(
          '保存した本文が見つかりません。章立ての作り直しや削除で消えた可能性があります。もう一度生成してください。'
        )
        return
      }

      // Advance queue before notifying subscribers so client refetch sees updated job
      try {
        await this.advanceGenerationJob()
      } catch {
        // best-effort: don't fail chapter completion due to job advancement error
      }

      this.phase = 'done'
      this.stage = null
      await this.persistAll()

      const encoder = new TextEncoder()
      const event = encoder.encode(
        `data: ${JSON.stringify({ done: true, chapterId: saved.chapterId, title: saved.title })}\n\n`
      )
      await this.fanout(event)
      await this.closeAll()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await this.transitionError(msg)
    }
  }

  // 段階 1〜3: 文脈の組み立て、本文のストリーム、保存。書けなかったときは error に遷移して null を返す。
  // 打ち切り (finishReason が STOP 以外) は、本文を保存してから error にして null を返す (現状どおり)。
  private async writeChapter(payload: StartChapterGenPayload): Promise<SavedChapter | null> {
    const encoder = new TextEncoder()
    await this.enterStage('context')
    const built = await this.withPrisma((prisma) =>
      buildChapterContext(prisma, this.env, payload, { onProgress: () => this.markProgress() })
    )
    if (!built.ok) {
      await this.transitionError(built.error)
      return null
    }
    const context = built.context

    await this.enterStage('writing')
    const result = streamChapter(this.env, {
      prompt: context.prompt,
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
      return null
    }

    // D1 へ章本文を保存 (途中打ち切りでも残しておいて、UI 側で再生成判断できるようにする)
    const prisma = this.makePrisma()
    let saved: { id: string }
    try {
      saved = await saveChapter(
        prisma,
        payload.novelId,
        payload.chapterNumber,
        this.buffer,
        context.title,
        context.storagePrompt,
        context.lineage
      )
    } catch (e) {
      await prisma.$disconnect()
      const msg = e instanceof Error ? e.message : String(e)
      await this.transitionError(`save_failed: ${msg}`)
      return null
    }

    // コスト記録 (best-effort。記録の失敗で保存済みの本文を error にしない)。
    // 保存先をストレージに書く前に記録する。書いた後に止まると、再開は記録の抽出から始まり、本文のコストが残らないため。
    // 記録の後、保存先を書く前に止まった場合は最初からやり直して本文を作り直すので、コストの行が 2 つになるのは実費どおり。
    if (usage) {
      try {
        await recordGenerationCost(prisma, this.env, {
          novelId: payload.novelId,
          chapterNumber: payload.chapterNumber,
          kind: 'chapter',
          usage
        })
      } catch (e) {
        console.warn('chapter cost record failed', e)
      }
    }
    await prisma.$disconnect()

    // 保存先をストレージに書く。この後で run() が止まっても、再開は記録の抽出から (本文を二重に作らない)。
    // 打ち切りの error も同じ書き込みに入れる。chapterId だけを先に書くと、その直後に止まったときに
    // 再開が打ち切りを見落として done にしてしまうため。
    this.chapterId = saved.id
    this.chapterTitle = context.title
    if (truncated) {
      this.phase = 'error'
      this.errMsg = truncationMessage(finishReason)
      this.stage = null
    }
    await this.persistAll()

    if (truncated) {
      // 途中打ち切り: 部分本文は D1 に保存済み。UI には error として通知し、ユーザーが再生成を判断できるようにする。
      try {
        await this.failGenerationJob()
      } catch {
        // best-effort
      }
      const errEvent = encoder.encode(`data: ${JSON.stringify({ error: this.errMsg })}\n\n`)
      await this.fanout(errEvent)
      await this.closeAll()
      return null
    }

    return {
      chapterId: saved.id,
      title: context.title,
      fresh: { content: this.buffer, editorModel: context.editorModel, materials: context.record }
    }
  }

  // 段階 4: 記録の抽出と保存。失敗しても章は完了扱いにする (record は null のまま) ので、ここで起きた例外は外へ出さない。
  // 'missing' は、再開したのに保存済みの本文が D1 から消えていたとき (章立ての作り直しや章の削除)。
  private async recordChapter(payload: StartChapterGenPayload, saved: SavedChapter): Promise<'ok' | 'missing'> {
    await this.enterStage('recording')
    try {
      return await this.withPrisma(async (prisma): Promise<'ok' | 'missing'> => {
        const job = await this.recordJob(prisma, payload, saved)
        if (job === 'missing') return 'missing'
        if (job === 'skip') return 'ok'
        this.markProgress()
        await extractAndSaveRecord(
          prisma,
          this.env,
          jsonCaller(this.env, job.editorModel),
          {
            novelId: payload.novelId,
            chapterId: saved.chapterId,
            chapterNumber: payload.chapterNumber,
            title: job.title,
            content: job.content
          },
          job.materials
        )
        this.markProgress()
        // 抽出の間 (1〜2 分) に章が削除されていたら、次の章へ進まずに error にする (再開の経路と同じ扱い)。
        // 消えた保存先で done を送ると、画面とジョブが存在しない版を完了として扱うため。
        const still = await findChapterVersion(prisma, saved.chapterId)
        return recordStageAction(still) === 'missing' ? 'missing' : 'ok'
      })
    } catch (e) {
      console.warn(`chapter ${payload.chapterNumber} record stage failed`, e)
      return 'ok'
    }
  }

  // 記録の抽出に使う本文と材料。今回の run() で書いた章はメモリにあるものを使う。
  // 再開のときは D1 から読み直す (保存済みの行に検証できる記録があれば抽出しない)。
  private async recordJob(
    prisma: PrismaClient,
    payload: StartChapterGenPayload,
    saved: SavedChapter
  ): Promise<RecordJob | 'missing' | 'skip'> {
    if (saved.fresh !== null) return { title: saved.title, ...saved.fresh }
    const row = await findChapterVersion(prisma, saved.chapterId)
    const action = recordStageAction(row)
    if (row === null || action !== 'extract') return action === 'missing' ? 'missing' : 'skip'
    const loaded = await loadRecordMaterials(prisma, payload)
    // 小説ごと消えていれば、章の行も消えている
    if (loaded === null) return 'missing'
    return { title: row.title, content: row.content, editorModel: loaded.editorModel, materials: loaded.materials }
  }

  // 段階に入ったことを覚えて、購読中の画面に知らせる。段階の切り替わりも進捗として数える。
  private async enterStage(stage: ChapterStage) {
    this.stage = stage
    this.markProgress()
    await this.ctx.storage.put('lastProgressAt', this.lastProgressAt)
    await this.fanout(new TextEncoder().encode(`data: ${JSON.stringify({ stage })}\n\n`))
  }

  // LLM を呼ぶ前後 (文脈の組み立て中の記録の抽出、記録の抽出) にも進捗を更新する。
  private markProgress() {
    this.lastProgressAt = Date.now()
  }

  // alarm と openStream が止まった run() を起動し直す前の状態。本文を保存済みなら、本文と保存先を残す。
  private prepareRestart() {
    const restarted = restartState({ buffer: this.buffer, chapterId: this.chapterId, chapterTitle: this.chapterTitle })
    this.buffer = restarted.buffer
    this.chapterId = restarted.chapterId
    this.chapterTitle = restarted.chapterTitle
    this.errMsg = null
    this.stage = null
    this.lastProgressAt = Date.now()
  }

  private async withPrisma<T>(fn: (prisma: PrismaClient) => Promise<T>): Promise<T> {
    const prisma = this.makePrisma()
    try {
      return await fn(prisma)
    } finally {
      await prisma.$disconnect()
    }
  }

  private async transitionError(msg: string) {
    this.phase = 'error'
    this.errMsg = msg
    this.stage = null
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

      // 次の章の文脈は、次の章の DO が D1 から組み立てる (章立てにその章が無ければ、そちらが error にしてジョブを止める)。
      const doId = this.env.CHAPTER_GEN.idFromName(`${this.payload.novelId}:${nextChapter}`)
      const stub = this.env.CHAPTER_GEN.get(doId)
      await stub.start({
        novelId: this.payload.novelId,
        chapterNumber: nextChapter,
        model: this.payload.model !== undefined ? this.payload.model : DEFAULT_FALLBACK_MODEL
      })
    } finally {
      await prisma.$disconnect()
    }
  }

  private makePrisma(): PrismaClient {
    const adapter = new PrismaD1(this.env.DB)
    return new PrismaClient({ adapter })
  }
}
