import { z } from 'zod'

// ---------------------- LLM プロバイダと /models ----------------------
// OpenAI 互換側のモデル名はハードコードせず、サーバーの GET /models をそのまま使う。
// URL と API キーは Worker の env だけが持ち、WebUI には「設定済みか」しか渡さない。

export const PROVIDERS = ['gemini', 'openai'] as const
export const ProviderSchema = z.enum(PROVIDERS)
export type Provider = z.infer<typeof ProviderSchema>

// 1M トークンあたりの USD。
export const ModelPriceSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  // 入力が 20 万トークンを超えると上がるモデル (Gemini Pro 系)。表の値は 20 万以下。
  longPromptSurcharge: z.boolean().default(false)
})
export type ModelPrice = z.infer<typeof ModelPriceSchema>

// 画面に出すモデル 1 件。
// ref は DB と API が持つ保存値 (Gemini は従来の id のまま、OpenAI 互換は `openai:<id>`)。
// price が無いモデル (サーバーが pricing を返さない) は null にして、画面に「単価不明」と出す。
export const AvailableModelSchema = z.object({
  ref: z.string().nonempty(),
  name: z.string().nonempty(),
  provider: ProviderSchema,
  // 互換サーバーが返す提供元 (owned_by)。表示用。
  owner: z.string().nonempty().nullable(),
  contextWindow: z.number().int().positive().nullable(),
  price: ModelPriceSchema.nullable()
})
export type AvailableModel = z.infer<typeof AvailableModelSchema>

export const ModelCatalogSchema = z.object({
  // OPENAI_BASE_URL と OPENAI_API_KEY の両方が設定されているか。値そのものは返さない。
  openaiConfigured: z.boolean(),
  // 呼び出す形式。サーバーの OPENAI_API_FORMAT で決まる。
  openaiFormat: z.enum(['chat', 'responses']),
  // /models の取得に失敗したときの理由 (未設定・成功のときは null)。画面に出して原因に気付けるようにする。
  openaiError: z.string().nonempty().nullable(),
  models: z.array(AvailableModelSchema)
})
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>

// 互換サーバーの GET /models の 1 件。必須は id だけ。余計なフィールドは捨てるので、
// サーバーが項目を足しても壊れない。
export const UpstreamModelSchema = z.object({
  id: z.string().nonempty(),
  owned_by: z.string().nonempty().optional(),
  // 入力の上限 (トークン)。項目名はサーバーごとに違う (多くは context_window、OpenRouter は context_length、vLLM は max_model_len)。
  // null や小数が入っていてもモデルごと捨てないよう、型は問わずに受ける。使う値は openai/models.ts の contextWindowOf が選ぶ。
  context_window: z.unknown().optional(),
  context_length: z.unknown().optional(),
  max_model_len: z.unknown().optional(),
  pricing: z
    .object({
      input: z.number().nonnegative(),
      output: z.number().nonnegative()
    })
    .optional()
})
export type UpstreamModel = z.infer<typeof UpstreamModelSchema>

export const UpstreamModelListSchema = z.object({
  data: z.array(z.unknown())
})
