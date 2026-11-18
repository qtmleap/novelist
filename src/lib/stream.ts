import { type ChapterStage, ChapterStreamEventSchema } from '@/schemas/novel.dto'

export type StreamHandlers = {
  onDelta: (text: string) => void
  onDone: (payload: { chapterId: string; title: string }) => void
  onError: (message: string) => void
  // 段階の切り替わり (資料の準備、執筆、記録の抽出)。本文が流れていない間の表示に使う。
  onStage?: (stage: ChapterStage) => void
  // 接続が切れて再接続したとき (2 回目以降の open) に、本文を送り直される前に呼ぶ。
  // サーバーは接続のたびにそれまでの本文を 1 つの delta でまとめて送り直すので、
  // 受け手は表示中の本文を空にしておかないと二重になる。最初の接続では呼ばない。
  onReset?: () => void
}

/**
 * 章本文 SSE を購読する。Worker 側で DO が「過去 buffer をまとめて 1 delta で replay → 以降の差分」を
 * 送ってくるので、シンプルに onDelta は積み増し前提で扱える。
 * EventSource は接続切れで自動再接続する。明示的に止めるには close() を呼ぶ。
 * 戻り値は { close } のみ。
 */
export function subscribeChapterStream(url: string, handlers: StreamHandlers): { close: () => void } {
  const es = new EventSource(url)
  // let を使わず、接続を一度でも開いたかを覚えておく。
  const connection = { opened: false }

  es.onopen = () => {
    if (connection.opened) handlers.onReset?.()
    connection.opened = true
  }

  es.onmessage = (e) => {
    let json: unknown
    try {
      json = JSON.parse(e.data)
    } catch {
      return
    }
    const parsed = ChapterStreamEventSchema.safeParse(json)
    if (!parsed.success) return
    const event = parsed.data
    if ('delta' in event) {
      handlers.onDelta(event.delta)
    } else if ('done' in event && event.done) {
      handlers.onDone({ chapterId: event.chapterId, title: event.title })
      es.close()
    } else if ('error' in event) {
      handlers.onError(event.error)
      es.close()
    } else if ('stage' in event) {
      handlers.onStage?.(event.stage)
    }
  }

  es.onerror = () => {
    // EventSource 自体は自動再接続を試みるため、ここで close せず browser に任せる。
    // 致命的な失敗 (404 等) は readyState === CLOSED で残るので、その場合のみ error 通知。
    if (es.readyState === EventSource.CLOSED) {
      handlers.onError('ストリーム接続が切断されました')
    }
  }

  return {
    close: () => {
      es.close()
    }
  }
}
