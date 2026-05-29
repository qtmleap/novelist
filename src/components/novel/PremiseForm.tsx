'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2, PenLine, Plus, Save, Trash2, UserPlus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { type Resolver, useFieldArray, useForm } from 'react-hook-form'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api/client'
import type { Character } from '@/schemas/character.dto'
import { ADDRESS_STYLES, CHARACTER_ROLES } from '@/schemas/character.dto'
import {
  AGE_RATING_OPTIONS,
  CHAPTER_LENGTH_OPTIONS,
  type CreateNovelInput,
  CreateNovelSchema,
  DEFAULT_AGE_RATING,
  DEFAULT_EDITOR_MODEL,
  DEFAULT_ENDING,
  DEFAULT_POV,
  DEFAULT_TARGET_CHARS,
  DEFAULT_TONE,
  DEFAULT_WRITER_MODEL,
  ENDING_OPTIONS,
  FOCAL_POVS,
  GEMINI_MODELS,
  GeminiModelSchema,
  POV_OPTIONS,
  RELATION_TYPES,
  TONE_OPTIONS
} from '@/schemas/novel.dto'

const GENRES = [
  'ファンタジー',
  'SF',
  '恋愛',
  'ミステリー',
  'ホラー',
  '歴史',
  '冒険',
  'ヒューマンドラマ',
  'コメディ',
  'その他'
]

const CHAPTER_COUNT_OPTIONS = Array.from({ length: 30 }, (_, i) => i + 1)

type Props = {
  onSubmit: (data: CreateNovelInput) => Promise<void>
  isSubmitting: boolean
  defaultValues?: CreateNovelInput
  mode?: 'create' | 'edit'
}

export const EMPTY_DEFAULTS: CreateNovelInput = {
  title: '',
  genre: '',
  characters: '',
  setting: '',
  num_chapters: 3,
  target_chars: DEFAULT_TARGET_CHARS,
  pov: DEFAULT_POV,
  tone: DEFAULT_TONE,
  age_rating: DEFAULT_AGE_RATING,
  pov_character_id: '',
  ending: DEFAULT_ENDING,
  notes: '',
  editor_model: DEFAULT_EDITOR_MODEL,
  writer_model: DEFAULT_WRITER_MODEL,
  character_links: [],
  relations: []
}

export function PremiseForm({ onSubmit, isSubmitting, defaultValues, mode = 'create' }: Props) {
  // 編集モードでは章数を減らせない (= 既に生成済みの章本文が宙ぶらりんになるため)。
  const minChapterCount = mode === 'edit' ? (defaultValues?.num_chapters ?? 1) : 1
  const [dictionary, setDictionary] = useState<Character[]>([])

  useEffect(() => {
    api
      .listCharacters()
      .then((data) => setDictionary(data))
      .catch(() => setDictionary([]))
  }, [])

  const form = useForm<CreateNovelInput>({
    resolver: zodResolver(CreateNovelSchema) as Resolver<CreateNovelInput>,
    defaultValues: defaultValues ?? EMPTY_DEFAULTS,
    mode: 'onSubmit'
  })

  const {
    fields: castFields,
    append: appendCast,
    remove: removeCast
  } = useFieldArray({ control: form.control, name: 'character_links' })

  const {
    fields: relationFields,
    append: appendRelation,
    remove: removeRelation
  } = useFieldArray({ control: form.control, name: 'relations' })

  const characterLinks = form.watch('character_links')
  const relations = form.watch('relations')
  const pov = form.watch('pov')

  // IDs of characters already added to the cast
  const selectedIds = new Set(characterLinks.map((l) => l.character_id).filter(Boolean))

  // Cast entries resolved to Character objects (for relation source/target selects)
  const castCharacters = characterLinks
    .map((l) => dictionary.find((c) => c.id === l.character_id))
    .filter((c): c is Character => c !== undefined)

  const canAddRelation = castCharacters.length >= 2
  const showNarratorSelect = FOCAL_POVS.includes(pov) && castCharacters.length > 0

  const submit = form.handleSubmit(onSubmit)

  return (
    <form onSubmit={submit} className='space-y-8'>
      {/* ── 基本情報 ── */}
      <div className='space-y-4'>
        <div>
          <h2 className='text-sm font-semibold'>小説の情報</h2>
          <p className='mt-0.5 text-sm text-muted-foreground'>タイトル・ジャンル・舞台を入力してください。</p>
        </div>

        <div className='space-y-2'>
          <Label htmlFor='title'>タイトル</Label>
          <Input id='title' placeholder='例: 星降る王国の伝説' {...form.register('title')} />
          {form.formState.errors.title && (
            <p className='text-xs text-destructive'>{form.formState.errors.title.message}</p>
          )}
        </div>

        <div className='space-y-2'>
          <Label htmlFor='genre'>ジャンル</Label>
          <Select
            value={form.watch('genre')}
            onValueChange={(v) => form.setValue('genre', v, { shouldValidate: false })}
          >
            <SelectTrigger id='genre'>
              <SelectValue placeholder='ジャンルを選択' />
            </SelectTrigger>
            <SelectContent>
              {GENRES.map((g) => (
                <SelectItem key={g} value={g}>
                  {g}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {form.formState.errors.genre && (
            <p className='text-xs text-destructive'>{form.formState.errors.genre.message}</p>
          )}
        </div>

        <div className='space-y-2'>
          <Label htmlFor='setting'>舞台・世界観</Label>
          <Textarea
            id='setting'
            placeholder='例: 魔法が存在する中世ヨーロッパ風の王国。500年前に封印された古代の呪いが再び目覚めようとしている。'
            rows={4}
            {...form.register('setting')}
            className='resize-none'
          />
          {form.formState.errors.setting && (
            <p className='text-xs text-destructive'>{form.formState.errors.setting.message}</p>
          )}
        </div>

        <div className='space-y-2'>
          <Label htmlFor='characters'>
            登場人物メモ <span className='text-muted-foreground font-normal'>（任意）</span>
          </Label>
          <Textarea
            id='characters'
            placeholder='例: 主人公・ルカ（17歳、孤独な魔法使いの見習い）、ヒロイン・アリア（謎の精霊）'
            rows={3}
            {...form.register('characters')}
            className='resize-none'
          />
          <p className='text-xs text-muted-foreground'>登場人物辞典を使う場合は下の「登場人物」で選択してください。</p>
          {form.formState.errors.characters && (
            <p className='text-xs text-destructive'>{form.formState.errors.characters.message}</p>
          )}
        </div>

        <div className='space-y-2'>
          <Label htmlFor='notes'>
            物語に入れたいシーン・展開 <span className='text-muted-foreground font-normal'>（任意）</span>
          </Label>
          <Textarea
            id='notes'
            placeholder={
              '例:\n- 主人公とヒロインがカラオケで歌う場面\n- 親友がさり気なく主人公を励ますシーン\n- ラスト近くで雨が降る'
            }
            rows={4}
            {...form.register('notes')}
            className='resize-none'
          />
          <p className='text-xs text-muted-foreground'>
            章立ての (再)生成時に AI が各章へ振り分けて反映します。本文生成時は章立て側に乗っているので再注入しません。
          </p>
          {form.formState.errors.notes && (
            <p className='text-xs text-destructive'>{form.formState.errors.notes.message}</p>
          )}
        </div>

        <div className='flex flex-wrap gap-4'>
          <div className='space-y-2'>
            <Label htmlFor='num_chapters'>章数</Label>
            <Select
              value={String(form.watch('num_chapters'))}
              onValueChange={(v) => form.setValue('num_chapters', Number(v), { shouldValidate: false })}
            >
              <SelectTrigger id='num_chapters' className='w-32'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CHAPTER_COUNT_OPTIONS.filter((n) => n >= minChapterCount).map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n} 章
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {mode === 'edit' && (
              <p className='text-xs text-muted-foreground'>整合性のため、章数は減らせません (増やすのは可)。</p>
            )}
            {form.formState.errors.num_chapters && (
              <p className='text-xs text-destructive'>{form.formState.errors.num_chapters.message}</p>
            )}
          </div>

          <div className='space-y-2'>
            <Label htmlFor='target_chars'>1章あたりの目標文字数</Label>
            <Select
              value={String(form.watch('target_chars'))}
              onValueChange={(v) => form.setValue('target_chars', Number(v), { shouldValidate: false })}
            >
              <SelectTrigger id='target_chars' className='w-40'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CHAPTER_LENGTH_OPTIONS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n.toLocaleString()} 文字
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className='text-xs text-muted-foreground'>
              （目安。2.0 系モデルは長い指定だと途中で切れることがあります）
            </p>
            {form.formState.errors.target_chars && (
              <p className='text-xs text-destructive'>{form.formState.errors.target_chars.message}</p>
            )}
          </div>
        </div>
      </div>

      {/* ── 文体 ── */}
      <div className='space-y-4'>
        <div>
          <h2 className='text-sm font-semibold'>文体</h2>
          <p className='mt-0.5 text-sm text-muted-foreground'>視点・文体トーン・エンディングを選択してください。</p>
        </div>

        <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4'>
          <div className='space-y-2'>
            <Label htmlFor='pov'>視点</Label>
            <Select
              value={pov}
              onValueChange={(v) => {
                form.setValue('pov', v, { shouldValidate: false })
                if (!FOCAL_POVS.includes(v)) {
                  form.setValue('pov_character_id', '')
                }
              }}
            >
              <SelectTrigger id='pov' className='w-full'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {POV_OPTIONS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className='space-y-2'>
            <Label htmlFor='tone'>文体トーン</Label>
            <Select
              value={form.watch('tone')}
              onValueChange={(v) => form.setValue('tone', v, { shouldValidate: false })}
            >
              <SelectTrigger id='tone' className='w-full'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TONE_OPTIONS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className='space-y-2'>
            <Label htmlFor='age_rating'>年齢指定</Label>
            <Select
              value={form.watch('age_rating')}
              onValueChange={(v) => form.setValue('age_rating', v, { shouldValidate: false })}
            >
              <SelectTrigger id='age_rating' className='w-full'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AGE_RATING_OPTIONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className='space-y-2'>
            <Label htmlFor='ending'>エンディング</Label>
            <Select
              value={form.watch('ending')}
              onValueChange={(v) => form.setValue('ending', v, { shouldValidate: false })}
            >
              <SelectTrigger id='ending' className='w-full'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENDING_OPTIONS.map((e) => (
                  <SelectItem key={e} value={e}>
                    {e}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className='space-y-2'>
            <Label htmlFor='editor_model'>Editor モデル (章立て)</Label>
            <Select
              value={form.watch('editor_model')}
              onValueChange={(v) =>
                form.setValue('editor_model', GeminiModelSchema.parse(v), { shouldValidate: false })
              }
            >
              <SelectTrigger id='editor_model' className='w-full'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GEMINI_MODELS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className='space-y-2'>
            <Label htmlFor='writer_model'>Writer モデル (本文)</Label>
            <Select
              value={form.watch('writer_model')}
              onValueChange={(v) =>
                form.setValue('writer_model', GeminiModelSchema.parse(v), { shouldValidate: false })
              }
            >
              <SelectTrigger id='writer_model' className='w-full'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GEMINI_MODELS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {showNarratorSelect && (
          <div className='space-y-2'>
            <Label htmlFor='pov_character_id'>語り手（視点人物）</Label>
            <Select
              value={form.watch('pov_character_id')}
              onValueChange={(v) => form.setValue('pov_character_id', v, { shouldValidate: false })}
            >
              <SelectTrigger id='pov_character_id' className='w-52'>
                <SelectValue placeholder='自動（主人公）' />
              </SelectTrigger>
              <SelectContent>
                {castCharacters.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className='text-xs text-muted-foreground'>
              一人称／三人称一元視点のとき、語り手にする人物を選べます（空欄なら主人公）
            </p>
          </div>
        )}
      </div>

      {/* ── 登場人物 ── */}
      <div className='space-y-4'>
        <div>
          <h2 className='text-sm font-semibold'>登場人物</h2>
          <p className='mt-0.5 text-sm text-muted-foreground'>登場人物辞典から選択し、この小説での役割を設定します。</p>
        </div>

        {dictionary.length === 0 ? (
          <p className='text-sm text-muted-foreground'>
            登場人物がまだ登録されていません。{' '}
            <a href='/characters/new' className='underline underline-offset-2'>
              辞典に追加する
            </a>
          </p>
        ) : (
          <>
            {castFields.length > 0 && (
              <div className='divide-y border-y'>
                {castFields.map((field, idx) => {
                  const link = characterLinks[idx]
                  return (
                    <div key={field.id} className='flex items-center gap-2 px-3 py-2'>
                      <Select
                        value={link?.character_id ?? ''}
                        onValueChange={(v) => {
                          form.setValue(`character_links.${idx}.character_id`, v, { shouldValidate: false })
                        }}
                      >
                        <SelectTrigger className='w-40'>
                          <SelectValue placeholder='登場人物を選択' />
                        </SelectTrigger>
                        <SelectContent>
                          {dictionary
                            .filter((c) => !selectedIds.has(c.id) || c.id === link?.character_id)
                            .map((c) => (
                              <SelectItem key={c.id} value={c.id}>
                                {c.name}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                      <Select
                        value={link?.role ?? ''}
                        onValueChange={(v) => {
                          form.setValue(`character_links.${idx}.role`, v, { shouldValidate: false })
                        }}
                      >
                        <SelectTrigger className='w-36'>
                          <SelectValue placeholder='役割（任意）' />
                        </SelectTrigger>
                        <SelectContent>
                          {CHARACTER_ROLES.map((r) => (
                            <SelectItem key={r} value={r}>
                              {r}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type='button'
                        variant='ghost'
                        size='icon'
                        aria-label='削除'
                        className='size-8 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive [&_svg]:size-5!'
                        onClick={() => {
                          // also remove relations that reference this character
                          const removedId = characterLinks[idx]?.character_id
                          removeCast(idx)
                          if (removedId) {
                            const nextRelations = relations.filter(
                              (r) => r.source_character_id !== removedId && r.target_character_id !== removedId
                            )
                            form.setValue('relations', nextRelations)
                            if (form.getValues('pov_character_id') === removedId) {
                              form.setValue('pov_character_id', '')
                            }
                          }
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  )
                })}
              </div>
            )}
            {castFields.length < dictionary.length && (
              <Button
                type='button'
                variant='outline'
                size='sm'
                className='[&_svg]:size-5!'
                onClick={() => appendCast({ character_id: '', role: '' })}
              >
                <UserPlus />
                登場人物を追加
              </Button>
            )}
          </>
        )}
      </div>

      {/* ── 登場人物間の関係 ── */}
      <div className='space-y-4'>
        <div>
          <h2 className='text-sm font-semibold'>登場人物間の関係</h2>
          <p className='mt-0.5 text-sm text-muted-foreground'>
            {canAddRelation
              ? 'キャスト内の登場人物同士の関係を設定します（任意）。呼び方は空欄なら人物既定の呼び方を使います。'
              : '登場人物を 2 人以上追加すると関係を設定できます。'}
          </p>
        </div>

        {canAddRelation && (
          <>
            {relationFields.length > 0 && (
              <div className='divide-y border-y'>
                {relationFields.map((field, idx) => {
                  const rel = relations[idx]
                  return (
                    <div key={field.id} className='flex flex-wrap items-center gap-2 px-3 py-2'>
                      <Select
                        value={rel?.source_character_id ?? ''}
                        onValueChange={(v) => {
                          form.setValue(`relations.${idx}.source_character_id`, v, { shouldValidate: false })
                          // reset target if same
                          if (rel?.target_character_id === v) {
                            form.setValue(`relations.${idx}.target_character_id`, '', { shouldValidate: false })
                          }
                        }}
                      >
                        <SelectTrigger className='w-36'>
                          <SelectValue placeholder='人物 A' />
                        </SelectTrigger>
                        <SelectContent>
                          {castCharacters.map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              {c.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <span className='text-xs text-muted-foreground shrink-0'>→</span>
                      <Select
                        value={rel?.target_character_id ?? ''}
                        onValueChange={(v) =>
                          form.setValue(`relations.${idx}.target_character_id`, v, { shouldValidate: false })
                        }
                      >
                        <SelectTrigger className='w-36'>
                          <SelectValue placeholder='人物 B' />
                        </SelectTrigger>
                        <SelectContent>
                          {castCharacters
                            .filter((c) => c.id !== rel?.source_character_id)
                            .map((c) => (
                              <SelectItem key={c.id} value={c.id}>
                                {c.name}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                      <Select
                        value={rel?.relation ?? ''}
                        onValueChange={(v) => form.setValue(`relations.${idx}.relation`, v, { shouldValidate: false })}
                      >
                        <SelectTrigger className='w-32'>
                          <SelectValue placeholder='関係' />
                        </SelectTrigger>
                        <SelectContent>
                          {RELATION_TYPES.map((t) => (
                            <SelectItem key={t} value={t}>
                              {t}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        placeholder='説明（任意）'
                        className='min-w-0 flex-1'
                        {...form.register(`relations.${idx}.description`)}
                      />
                      <Select
                        value={rel?.address_override ?? ''}
                        onValueChange={(v) =>
                          form.setValue(`relations.${idx}.address_override`, v, { shouldValidate: false })
                        }
                      >
                        <SelectTrigger className='w-40'>
                          <SelectValue placeholder='呼び方（上書き）' />
                        </SelectTrigger>
                        <SelectContent>
                          {ADDRESS_STYLES.map((s) => (
                            <SelectItem key={s} value={s}>
                              {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type='button'
                        variant='ghost'
                        size='icon'
                        aria-label='削除'
                        className='size-8 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive [&_svg]:size-5!'
                        onClick={() => removeRelation(idx)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  )
                })}
              </div>
            )}
            <Button
              type='button'
              variant='outline'
              size='sm'
              className='[&_svg]:size-5!'
              onClick={() =>
                appendRelation({
                  source_character_id: '',
                  target_character_id: '',
                  relation: '',
                  description: '',
                  address_override: ''
                })
              }
            >
              <Plus />
              関係を追加
            </Button>
          </>
        )}
      </div>

      <Button type='submit' size='sm' disabled={isSubmitting} className='[&_svg]:size-5!'>
        {isSubmitting ? (
          <>
            <Loader2 className='animate-spin' />
            {mode === 'edit' ? '保存中...' : '作成中...'}
          </>
        ) : mode === 'edit' ? (
          <>
            <Save />
            変更を保存
          </>
        ) : (
          <>
            <PenLine />
            小説を作成
          </>
        )}
      </Button>
    </form>
  )
}
