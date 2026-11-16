import { atomWithStorage } from 'jotai/utils'
import { DEFAULT_EDITOR_MODEL, DEFAULT_WRITER_MODEL, type ModelRef, ModelRefSchema } from '@/schemas/novel.dto'

// --- Theme ---

// Plain-string storage adapter — existing 'theme' values in localStorage are not JSON-encoded
const strStorage = {
  getItem: (key: string, initialValue: 'dark' | 'light'): 'dark' | 'light' => {
    if (typeof window === 'undefined') return initialValue
    const v = localStorage.getItem(key)
    return v === 'dark' || v === 'light' ? v : initialValue
  },
  setItem: (key: string, value: 'dark' | 'light'): void => {
    localStorage.setItem(key, value)
  },
  removeItem: (key: string): void => {
    localStorage.removeItem(key)
  }
}

export const themeAtom = atomWithStorage<'dark' | 'light'>('theme', 'light', strStorage, { getOnInit: true })

// --- AI model settings ---

// 保存値は ModelRef。Gemini は従来の id のまま、OpenAI 互換は `openai:<id>`。
// 既存ユーザーの localStorage (Gemini の id) はそのまま読める。
const modelStorage = {
  getItem: (key: string, initialValue: ModelRef): ModelRef => {
    if (typeof window === 'undefined') return initialValue
    const raw = localStorage.getItem(key)
    const parsed = ModelRefSchema.safeParse(raw)
    return parsed.success ? parsed.data : initialValue
  },
  setItem: (key: string, value: ModelRef): void => {
    localStorage.setItem(key, value)
  },
  removeItem: (key: string): void => {
    localStorage.removeItem(key)
  }
}

export const editorModelAtom = atomWithStorage<ModelRef>('ai-novel:editorModel', DEFAULT_EDITOR_MODEL, modelStorage, {
  getOnInit: true
})

export const writerModelAtom = atomWithStorage<ModelRef>('ai-novel:writerModel', DEFAULT_WRITER_MODEL, modelStorage, {
  getOnInit: true
})
