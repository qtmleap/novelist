'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient, useSuspenseQueries } from '@tanstack/react-query'
import { Loader2, PenLine, Plus, Save, Trash2, UserPlus } from 'lucide-react'
import { useState } from 'react'
import type { DefaultValues } from 'react-hook-form'
import { type Resolver, useFieldArray, useForm } from 'react-hook-form'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api/client'
import { routes } from '@/lib/routes'
import type { Character } from '@/schemas/character.dto'
import { ADDRESS_STYLES, CHARACTER_ROLES } from '@/schemas/character.dto'
import {
  AGE_RATING_OPTIONS,
  type Category,
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

// shadcn(Radix) Select は空文字 value を使えないため、「未分類」(= category_id: null) を
// 表す UI 専用のセンチネル。フォームの値自体は null のままで、Select 境界でのみ読み替える。
const NO_CATEGORY = '__none__'

type Props = {
  onSubmit: (data: CreateNovelInput) => Promise<void>
  isSubmitting: boolean
  defaultValues?: DefaultValues<CreateNovelInput>
  mode?: 'create' | 'edit'
}

// その項目が生成プロンプトのどこに渡るかをラベル横にバッジで示す。
function ScopeTag({ scope }: { scope: 'both' | 'outline' | 'body' }) {
  const text = scope === 'both' ? '章立て・本文' : scope === 'outline' ? '章立て' : '本文'
  return (
    <Badge variant='outline' className='ml-1.5 align-middle text-[10px] font-normal text-muted-foreground'>
      {text}
    </Badge>
  )
}

export const EMPTY_DEFAULTS: CreateNovelInput = {
  title: '',
  genre: '',
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
  category_id: null,
  character_links: [],
  relations: []
}

export function PremiseForm({ onSubmit, isSubmitting, defaultValues, mode = 'create' }: Props) {
  // 編集モードでは章数を減らせない (= 既に生成済みの章本文が宙ぶらりんになるため)。
  const minChapterCount =
    mode === 'edit' ? (typeof defaultValues?.num_chapters === 'number' ? defaultValues.num_chapters : 1) : 1
  const queryClient = useQueryClient()
  const [{ data: dictionary }, { data: categories }] = useSuspenseQueries({
    queries: [
      { queryKey: ['characters'], queryFn: () => api.listCharacters() },
      { queryKey: ['categories'], queryFn: () => api.listCategories() }
    ]
  })
  const [newCategoryOpen, setNewCategoryOpen] = useState(false)
  const [newCategoryName, setNewCategoryName] = useState('')
  const [creatingCategory, setCreatingCategory] = useState(false)

  const form = useForm<CreateNovelInput>({
    resolver: zodResolver(CreateNovelSchema) as Resolver<CreateNovelInput>,
    defaultValues: defaultValues !== undefined ? defaultValues : EMPTY_DEFAULTS,
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

  // IDs of characters already added to the cast
  const selectedIds = new Set(characterLinks.map((l) => l.character_id).filter(Boolean))

  // Cast entries resolved to Character objects (for relation source/target selects)
  const castCharacters = characterLinks
    .map((l) => dictionary.find((c) => c.id === l.character_id))
    .filter((c): c is Character => c !== undefined)

  const canAddRelation = castCharacters.length >= 2
  const pov = form.watch('pov')
  const showNarratorSelect = FOCAL_POVS.includes(pov) && castCharacters.length > 0

  const submit = form.handleSubmit(onSubmit)

  const handleCreateCategory = async () => {
    const name = newCategoryName.trim()
    if (name.length === 0 || creatingCategory) return
    setCreatingCategory(true)
    try {
      const created = await api.createCategory({ name })
      queryClient.setQueryData<Category[]>(['categories'], (prev) => {
        const list = prev === undefined ? [] : prev
        return list.some((c) => c.id === created.id) ? list : [...list, created]
      })
      form.setValue('category_id', created.id)
      setNewCategoryName('')
      setNewCategoryOpen(false)
    } catch {
      // 失敗時は入力を残してユーザーが再試行できるようにする
    } finally {
      setCreatingCategory(false)
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={submit} className='space-y-8'>
        {/* ── 基本情報 ── */}
        <div className='space-y-4'>
          <div>
            <h2 className='text-sm font-semibold'>小説の情報</h2>
            <p className='mt-0.5 text-sm text-muted-foreground'>タイトル・ジャンル・舞台を入力してください。</p>
          </div>

          <FormField
            control={form.control}
            name='title'
            render={({ field }) => (
              <FormItem className='space-y-2'>
                <FormLabel>
                  タイトル
                  <ScopeTag scope='both' />
                </FormLabel>
                <FormControl>
                  <Input placeholder='例: 星降る王国の伝説' {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name='genre'
            render={({ field }) => (
              <FormItem className='space-y-2'>
                <FormLabel>
                  ジャンル
                  <ScopeTag scope='both' />
                </FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder='ジャンルを選択' />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {GENRES.map((g) => (
                      <SelectItem key={g} value={g}>
                        {g}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name='category_id'
            render={({ field }) => (
              <FormItem className='space-y-2'>
                <FormLabel>
                  カテゴリ <span className='text-muted-foreground font-normal'>（任意）</span>
                </FormLabel>
                <div className='flex flex-wrap items-center gap-2'>
                  <Select
                    value={field.value === null ? NO_CATEGORY : field.value}
                    onValueChange={(v) => field.onChange(v === NO_CATEGORY ? null : v)}
                  >
                    <FormControl>
                      <SelectTrigger className='w-52'>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NO_CATEGORY}>未分類</SelectItem>
                      {categories.map((cat) => (
                        <SelectItem key={cat.id} value={cat.id}>
                          {cat.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {newCategoryOpen ? (
                    <>
                      <Input
                        autoFocus
                        value={newCategoryName}
                        onChange={(e) => setNewCategoryName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            handleCreateCategory()
                          }
                        }}
                        placeholder='新しいカテゴリ名'
                        maxLength={50}
                        className='w-44'
                      />
                      <Button
                        type='button'
                        size='sm'
                        disabled={creatingCategory || newCategoryName.trim().length === 0}
                        onClick={handleCreateCategory}
                        className='h-9 [&_svg]:size-5!'
                      >
                        {creatingCategory ? <Loader2 className='animate-spin' /> : <Plus />}
                        追加
                      </Button>
                      <Button
                        type='button'
                        variant='ghost'
                        size='sm'
                        onClick={() => {
                          setNewCategoryOpen(false)
                          setNewCategoryName('')
                        }}
                        className='h-9'
                      >
                        キャンセル
                      </Button>
                    </>
                  ) : (
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      onClick={() => setNewCategoryOpen(true)}
                      className='h-9 [&_svg]:size-5!'
                    >
                      <Plus />
                      新規カテゴリ
                    </Button>
                  )}
                </div>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name='setting'
            render={({ field }) => (
              <FormItem className='space-y-2'>
                <FormLabel>
                  舞台・世界観
                  <ScopeTag scope='both' />
                </FormLabel>
                <FormControl>
                  <Textarea
                    placeholder='例: 魔法が存在する中世ヨーロッパ風の王国。500年前に封印された古代の呪いが再び目覚めようとしている。'
                    rows={4}
                    className='resize-none'
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name='notes'
            render={({ field }) => (
              <FormItem className='space-y-2'>
                <FormLabel>
                  物語に入れたいシーン・展開 <span className='text-muted-foreground font-normal'>（任意）</span>
                  <ScopeTag scope='outline' />
                </FormLabel>
                <FormControl>
                  <Textarea
                    placeholder={
                      '例:\n- 主人公とヒロインがカラオケで歌う場面\n- 親友がさり気なく主人公を励ますシーン\n- ラスト近くで雨が降る'
                    }
                    rows={4}
                    className='resize-none'
                    {...field}
                  />
                </FormControl>
                <p className='text-xs text-muted-foreground'>
                  章立ての (再)生成時に AI
                  が各章へ振り分けて反映します。本文生成時は章立て側に乗っているので再注入しません。
                </p>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className='flex flex-wrap items-start gap-4'>
            <FormField
              control={form.control}
              name='num_chapters'
              render={({ field }) => (
                <FormItem className='space-y-2'>
                  <FormLabel>
                    章数
                    <ScopeTag scope='outline' />
                  </FormLabel>
                  <Select value={String(field.value)} onValueChange={(v) => field.onChange(Number(v))}>
                    <FormControl>
                      <SelectTrigger className='w-32'>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
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
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name='target_chars'
              render={({ field }) => (
                <FormItem className='space-y-2'>
                  <FormLabel>
                    1章あたりの目標文字数
                    <ScopeTag scope='body' />
                  </FormLabel>
                  <Select value={String(field.value)} onValueChange={(v) => field.onChange(Number(v))}>
                    <FormControl>
                      <SelectTrigger className='w-40'>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
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
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        {/* ── 文体 ── */}
        <div className='space-y-4'>
          <div>
            <h2 className='text-sm font-semibold'>文体</h2>
            <p className='mt-0.5 text-sm text-muted-foreground'>視点・文体トーン・エンディングを選択してください。</p>
          </div>

          <div className='grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-4'>
            <FormField
              control={form.control}
              name='pov'
              render={({ field }) => (
                <FormItem className='space-y-2'>
                  <FormLabel>
                    視点
                    <ScopeTag scope='both' />
                  </FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(v) => {
                      field.onChange(v)
                      if (!FOCAL_POVS.includes(v)) {
                        form.setValue('pov_character_id', '')
                      }
                    }}
                  >
                    <FormControl>
                      <SelectTrigger className='w-full'>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {POV_OPTIONS.map((p) => (
                        <SelectItem key={p} value={p}>
                          {p}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name='tone'
              render={({ field }) => (
                <FormItem className='space-y-2'>
                  <FormLabel>
                    文体トーン
                    <ScopeTag scope='both' />
                  </FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className='w-full'>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {TONE_OPTIONS.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name='age_rating'
              render={({ field }) => (
                <FormItem className='space-y-2'>
                  <FormLabel>
                    年齢指定
                    <ScopeTag scope='both' />
                  </FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className='w-full'>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {AGE_RATING_OPTIONS.map((r) => (
                        <SelectItem key={r} value={r}>
                          {r}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name='ending'
              render={({ field }) => (
                <FormItem className='space-y-2'>
                  <FormLabel>
                    エンディング
                    <ScopeTag scope='both' />
                  </FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className='w-full'>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {ENDING_OPTIONS.map((e) => (
                        <SelectItem key={e} value={e}>
                          {e}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name='editor_model'
              render={({ field }) => (
                <FormItem className='space-y-2'>
                  <FormLabel>Editor モデル (章立て)</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(v) => {
                      const r = GeminiModelSchema.safeParse(v)
                      if (r.success) {
                        field.onChange(r.data)
                      }
                    }}
                  >
                    <FormControl>
                      <SelectTrigger className='w-full'>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {GEMINI_MODELS.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name='writer_model'
              render={({ field }) => (
                <FormItem className='space-y-2'>
                  <FormLabel>Writer モデル (本文)</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(v) => {
                      const r = GeminiModelSchema.safeParse(v)
                      if (r.success) {
                        field.onChange(r.data)
                      }
                    }}
                  >
                    <FormControl>
                      <SelectTrigger className='w-full'>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {GEMINI_MODELS.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          {showNarratorSelect && (
            <FormField
              control={form.control}
              name='pov_character_id'
              render={({ field }) => (
                <FormItem className='space-y-2'>
                  <FormLabel>
                    語り手（視点人物）
                    <ScopeTag scope='both' />
                  </FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className='w-52'>
                        <SelectValue placeholder='自動（主人公）' />
                      </SelectTrigger>
                    </FormControl>
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
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
        </div>

        {/* ── 登場人物 ── */}
        <div className='space-y-4'>
          <div>
            <h2 className='text-sm font-semibold'>登場人物</h2>
            <p className='mt-0.5 text-sm text-muted-foreground'>
              登場人物辞典から選択し、この小説での役割を設定します。
            </p>
          </div>

          {dictionary.length === 0 ? (
            <p className='text-sm text-muted-foreground'>
              登場人物がまだ登録されていません。{' '}
              <a href={routes.characters.new} className='underline underline-offset-2'>
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
                          value={link !== undefined ? link.character_id : ''}
                          onValueChange={(v) => {
                            form.setValue(`character_links.${idx}.character_id`, v, { shouldValidate: false })
                          }}
                        >
                          <SelectTrigger className='w-40'>
                            <SelectValue placeholder='登場人物を選択' />
                          </SelectTrigger>
                          <SelectContent>
                            {dictionary
                              .filter(
                                (c) => !selectedIds.has(c.id) || c.id === (link !== undefined ? link.character_id : '')
                              )
                              .map((c) => (
                                <SelectItem key={c.id} value={c.id}>
                                  {c.name}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                        <Select
                          value={link !== undefined ? link.role : ''}
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
                            const removedId =
                              characterLinks[idx] !== undefined ? characterLinks[idx].character_id : undefined
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
                          value={rel !== undefined ? rel.source_character_id : ''}
                          onValueChange={(v) => {
                            form.setValue(`relations.${idx}.source_character_id`, v, { shouldValidate: false })
                            // reset target if same
                            if (rel !== undefined && rel.target_character_id === v) {
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
                          value={rel !== undefined ? rel.target_character_id : ''}
                          onValueChange={(v) =>
                            form.setValue(`relations.${idx}.target_character_id`, v, { shouldValidate: false })
                          }
                        >
                          <SelectTrigger className='w-36'>
                            <SelectValue placeholder='人物 B' />
                          </SelectTrigger>
                          <SelectContent>
                            {castCharacters
                              .filter((c) => c.id !== (rel !== undefined ? rel.source_character_id : ''))
                              .map((c) => (
                                <SelectItem key={c.id} value={c.id}>
                                  {c.name}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                        <Select
                          value={rel !== undefined ? rel.relation : ''}
                          onValueChange={(v) =>
                            form.setValue(`relations.${idx}.relation`, v, { shouldValidate: false })
                          }
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
                          value={
                            rel !== undefined ? (rel.address_override !== undefined ? rel.address_override : '') : ''
                          }
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
    </Form>
  )
}
