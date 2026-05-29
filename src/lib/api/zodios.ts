import { makeApi, Zodios, type ZodiosOptions } from '@zodios/core'
import { z } from 'zod'
import { CharacterSchema, CreateCharacterSchema } from '@/schemas/character.dto'
import {
  CreateNovelSchema,
  GenerateOptionsSchema,
  GenerateOutlineOptionsSchema,
  NovelSchema,
  NovelWithChaptersSchema,
  OutlineSchema
} from '@/schemas/novel.dto'

// API レスポンスのラッパースキーマ。サーバー側は Hono のままで、
// ここで Zod の parse を噛ませてランタイム保証も得る。
const ErrorBodySchema = z.object({
  error: z.string(),
  detail: z.string().optional()
})

const OutlineWrapperSchema = z.object({ outline: OutlineSchema })
const PromptPreviewSchema = z.object({ prompt: z.string() })
const GenerateAckSchema = z.object({ status: z.enum(['started', 'already_streaming']) })
// /auth/me は常に 200 を返し、未認証なら email=null。これでフロントは「未認証 vs API ダウン」を切り分け可能。
const AuthStateSchema = z.object({ email: z.string().nullable() })

// makeApi は as const 配列を受けて alias 名でメソッドを生やすため、すべての
// エンドポイントを 1 つのリテラル配列にまとめないと型情報が縮退する。
export const api = makeApi([
  // ── Novel ──
  {
    method: 'get',
    path: '/api/novels',
    alias: 'listNovels',
    description: '小説一覧を取得',
    response: z.array(NovelSchema),
    errors: [{ status: 'default', schema: ErrorBodySchema }]
  },
  {
    method: 'post',
    path: '/api/novels',
    alias: 'createNovel',
    description: '小説を作成',
    parameters: [{ name: 'body', type: 'Body', schema: CreateNovelSchema }],
    response: NovelSchema,
    status: 201,
    errors: [{ status: 'default', schema: ErrorBodySchema }]
  },
  {
    method: 'get',
    path: '/api/novels/:id',
    alias: 'getNovel',
    description: '小説詳細を取得',
    response: NovelWithChaptersSchema,
    errors: [{ status: 'default', schema: ErrorBodySchema }]
  },
  {
    method: 'put',
    path: '/api/novels/:id',
    alias: 'updateNovel',
    description: '小説を更新',
    parameters: [{ name: 'body', type: 'Body', schema: CreateNovelSchema }],
    response: NovelSchema,
    errors: [{ status: 'default', schema: ErrorBodySchema }]
  },
  {
    method: 'delete',
    path: '/api/novels/:id',
    alias: 'deleteNovel',
    description: '小説を削除',
    response: z.unknown(),
    status: 204,
    errors: [{ status: 'default', schema: ErrorBodySchema }]
  },
  {
    method: 'post',
    path: '/api/novels/:id/outline',
    alias: 'generateOutline',
    description: '章立てを生成 (任意で章指定)',
    parameters: [{ name: 'body', type: 'Body', schema: GenerateOutlineOptionsSchema }],
    response: OutlineWrapperSchema,
    errors: [{ status: 'default', schema: ErrorBodySchema }]
  },
  {
    method: 'get',
    path: '/api/novels/:id/outline/preview',
    alias: 'previewOutlinePrompt',
    description: '章立て生成プロンプトのプレビュー',
    response: PromptPreviewSchema,
    errors: [{ status: 'default', schema: ErrorBodySchema }]
  },
  {
    method: 'post',
    path: '/api/novels/:id/outline/:number',
    alias: 'regenerateOutlineChapter',
    description: '指定章の章立てを再生成',
    parameters: [{ name: 'body', type: 'Body', schema: GenerateOptionsSchema }],
    response: OutlineWrapperSchema,
    errors: [{ status: 'default', schema: ErrorBodySchema }]
  },
  {
    method: 'post',
    path: '/api/novels/:id/chapters/:number/generate',
    alias: 'startChapterGeneration',
    description: '本文生成を Durable Object にキックオフ',
    parameters: [{ name: 'body', type: 'Body', schema: GenerateOptionsSchema }],
    response: GenerateAckSchema,
    status: 202,
    errors: [{ status: 'default', schema: ErrorBodySchema }]
  },
  {
    method: 'delete',
    path: '/api/novels/:id/chapters/:number',
    alias: 'deleteChapter',
    description: '最新章本文を削除',
    response: z.unknown(),
    status: 204,
    errors: [{ status: 'default', schema: ErrorBodySchema }]
  },
  // ── Character ──
  {
    method: 'get',
    path: '/api/characters',
    alias: 'listCharacters',
    description: '登場人物辞典を取得',
    response: z.array(CharacterSchema),
    errors: [{ status: 'default', schema: ErrorBodySchema }]
  },
  {
    method: 'post',
    path: '/api/characters',
    alias: 'createCharacter',
    description: '登場人物を登録',
    parameters: [{ name: 'body', type: 'Body', schema: CreateCharacterSchema }],
    response: CharacterSchema,
    status: 201,
    errors: [{ status: 'default', schema: ErrorBodySchema }]
  },
  {
    method: 'get',
    path: '/api/characters/:id',
    alias: 'getCharacter',
    description: '登場人物詳細を取得',
    response: CharacterSchema,
    errors: [{ status: 'default', schema: ErrorBodySchema }]
  },
  {
    method: 'put',
    path: '/api/characters/:id',
    alias: 'updateCharacter',
    description: '登場人物を更新',
    parameters: [{ name: 'body', type: 'Body', schema: CreateCharacterSchema }],
    response: CharacterSchema,
    errors: [{ status: 'default', schema: ErrorBodySchema }]
  },
  {
    method: 'delete',
    path: '/api/characters/:id',
    alias: 'deleteCharacter',
    description: '登場人物を削除',
    response: z.unknown(),
    status: 204,
    errors: [{ status: 'default', schema: ErrorBodySchema }]
  },
  // ── Auth ──
  {
    method: 'get',
    path: '/api/auth/me',
    alias: 'getAuthState',
    description: 'ログイン中のユーザー email を返す (未ログインなら null)',
    response: AuthStateSchema,
    errors: [{ status: 'default', schema: ErrorBodySchema }]
  }
] as const)

export function createApiClient(baseURL = '', options?: ZodiosOptions) {
  return new Zodios(baseURL, api, options)
}
