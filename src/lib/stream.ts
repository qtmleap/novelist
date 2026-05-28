import { ChapterStreamEventSchema } from '@/schemas/novel.dto'

export type StreamHandlers = {
  onDelta: (text: string) => void
  onDone: (payload: { chapterId: string; title: string }) => void
  onError: (message: string) => void
}

// Accept either a global Response or Hono's ClientResponse (which lacks `webSocket`).
type StreamResponse = { body: Response['body'] }

export async function readChapterStream(response: StreamResponse, handlers: StreamHandlers): Promise<void> {
  if (!response.body) {
    handlers.onError('レスポンスにボディがありません')
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      // Keep last potentially-partial line in buffer
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue

        const payload = trimmed.slice('data:'.length).trim()
        if (!payload || payload === '[DONE]') continue

        let json: unknown
        try {
          json = JSON.parse(payload)
        } catch {
          continue
        }

        const result = ChapterStreamEventSchema.safeParse(json)
        if (!result.success) continue

        const event = result.data
        if ('delta' in event) {
          handlers.onDelta(event.delta)
        } else if ('done' in event && event.done) {
          handlers.onDone({ chapterId: event.chapterId, title: event.title })
        } else if ('error' in event) {
          handlers.onError(event.error)
        }
      }
    }

    // Flush any remaining buffer content
    if (buffer.trim().startsWith('data:')) {
      const payload = buffer.trim().slice('data:'.length).trim()
      if (payload && payload !== '[DONE]') {
        let json: unknown
        try {
          json = JSON.parse(payload)
        } catch {
          return
        }
        const result = ChapterStreamEventSchema.safeParse(json)
        if (result.success) {
          const event = result.data
          if ('delta' in event) {
            handlers.onDelta(event.delta)
          } else if ('done' in event && event.done) {
            handlers.onDone({ chapterId: event.chapterId, title: event.title })
          } else if ('error' in event) {
            handlers.onError(event.error)
          }
        }
      }
    }
  } catch (err) {
    handlers.onError(err instanceof Error ? err.message : 'ストリームの読み込みに失敗しました')
  } finally {
    reader.releaseLock()
  }
}
