import { atomWithStorage } from 'jotai/utils'
import { DEFAULT_EDITOR_MODEL, DEFAULT_WRITER_MODEL, type GeminiModel, GeminiModelSchema } from '@/schemas/novel.dto'

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

const geminiStorage = {
  getItem: (key: string, initialValue: GeminiModel): GeminiModel => {
    if (typeof window === 'undefined') return initialValue
    const raw = localStorage.getItem(key)
    const parsed = GeminiModelSchema.safeParse(raw)
    return parsed.success ? parsed.data : initialValue
  },
  setItem: (key: string, value: GeminiModel): void => {
    localStorage.setItem(key, value)
  },
  removeItem: (key: string): void => {
    localStorage.removeItem(key)
  }
}

export const editorModelAtom = atomWithStorage<GeminiModel>(
  'ai-novel:editorModel',
  DEFAULT_EDITOR_MODEL,
  geminiStorage,
  { getOnInit: true }
)

export const writerModelAtom = atomWithStorage<GeminiModel>(
  'ai-novel:writerModel',
  DEFAULT_WRITER_MODEL,
  geminiStorage,
  { getOnInit: true }
)
