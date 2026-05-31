import { z } from 'zod'

// 独立したキャラクター辞典。役割は小説ごと (NovelCharacter) に持たせるため
// Character 自体には role を持たない。任意項目は空文字/空配列を既定にして null を避ける。

export const GENDER_OPTIONS = ['男性', '女性', 'その他', '不明'] as const
export const OCCUPATION_OPTIONS = [
  '学生',
  '会社員',
  '公務員',
  '自営業',
  '主婦・主夫',
  'アルバイト',
  '医師',
  '教員',
  'エンジニア',
  '作家',
  '芸術家',
  '軍人',
  '政治家',
  '騎士',
  '魔法使い',
  '戦士',
  '僧侶',
  '商人',
  '農民',
  '貴族',
  '王族',
  '冒険者',
  '無職',
  'その他'
] as const
export const FIRST_PERSON_OPTIONS = [
  '僕',
  '俺',
  '私',
  'わたし',
  'あたし',
  'わたくし',
  '自分',
  'うち',
  '自分の名前',
  'その他'
] as const

// 「自分の名前」が選ばれた場合、Gemini への一人称プロンプトでは「私(キャラ名)」ではなく
// 「自分自身をキャラ名で呼ぶ」形式に切り替える。判定用の番兵値。
export const FIRST_PERSON_AS_NAME = '自分の名前'

// 小説でのキャラの役割 (NovelCharacter.role の選択肢)
export const CHARACTER_ROLES = ['主人公', 'ヒロイン', '相棒', '敵役', '脇役', 'その他'] as const

// 他の人の呼び方 (Character.address_others の既定、関係ごとに上書き可)。
// 空文字 = 未設定。
export const ADDRESS_STYLES = [
  '君',
  '名前',
  '苗字',
  '名前＋ちゃん',
  '苗字＋ちゃん',
  '名前＋さん',
  '苗字＋さん'
] as const

export const CreateCharacterSchema = z.object({
  name: z.string().nonempty('名前を入力してください').max(100),
  gender: z.string().max(20).default(''),
  age: z.string().max(50).default(''),
  occupation: z.string().max(50).default(''),
  appearance: z.string().max(2000).default(''),
  first_person: z.string().max(20).default(''),
  address_others: z.string().max(500).default(''),
  speech_examples: z.array(z.string().max(300)).max(20).default([]),
  description: z.string().max(4000).default('')
})
export type CreateCharacterInput = z.infer<typeof CreateCharacterSchema>

// DB では speech_examples を JSON 文字列で保持し、API 層で配列に変換する。
export const CharacterSchema = z.object({
  id: z.string(),
  name: z.string(),
  gender: z.string(),
  age: z.string(),
  occupation: z.string(),
  appearance: z.string(),
  first_person: z.string(),
  address_others: z.string(),
  speech_examples: z.array(z.string()),
  description: z.string(),
  created_at: z.string(),
  updated_at: z.string()
})
export type Character = z.infer<typeof CharacterSchema>
