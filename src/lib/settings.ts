import { DEFAULT_EDITOR_MODEL, DEFAULT_WRITER_MODEL, type GeminiModel, GeminiModelSchema } from '@/schemas/novel.dto'

const KEY_EDITOR = 'ai-novel:editorModel'
const KEY_WRITER = 'ai-novel:writerModel'

export function getEditorModel(): GeminiModel {
  if (typeof window === 'undefined') return DEFAULT_EDITOR_MODEL
  const raw = localStorage.getItem(KEY_EDITOR)
  const parsed = GeminiModelSchema.safeParse(raw)
  return parsed.success ? parsed.data : DEFAULT_EDITOR_MODEL
}

export function getWriterModel(): GeminiModel {
  if (typeof window === 'undefined') return DEFAULT_WRITER_MODEL
  const raw = localStorage.getItem(KEY_WRITER)
  const parsed = GeminiModelSchema.safeParse(raw)
  return parsed.success ? parsed.data : DEFAULT_WRITER_MODEL
}

export function setEditorModel(m: GeminiModel): void {
  localStorage.setItem(KEY_EDITOR, m)
}

export function setWriterModel(m: GeminiModel): void {
  localStorage.setItem(KEY_WRITER, m)
}
