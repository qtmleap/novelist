'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Loader2, PenLine, Plus, Save } from 'lucide-react'
import { useState } from 'react'
import type { DefaultValues } from 'react-hook-form'
import { type Resolver, useForm } from 'react-hook-form'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api/client'
import { cn } from '@/lib/utils'
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
  GEMINI_MODELS,
  GeminiModelSchema,
  POV_OPTIONS,
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

// 必須項目を示す赤い * (React Hook Form は自動では付けないので明示する)。
function RequiredMark() {
  return <span className='ml-0.5 text-destructive'>*</span>
}

// その項目が生成プロンプトのどこに渡るかをラベル横にバッジで示す。
// 'both' は「章立て」「本文」を別々のバッジに分けて出す。
function ScopeTag({ scope }: { scope: 'both' | 'outline' | 'body' }) {
  const scopes = scope === 'both' ? (['outline', 'body'] as const) : ([scope] as const)
  return (
    <span className='inline-flex gap-1'>
      {scopes.map((s) => (
        <Badge
          key={s}
          className={cn(
            'border-transparent text-xs font-medium',
            s === 'outline'
              ? 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300'
              : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
          )}
        >
          {s === 'outline' ? '章立て' : '本文'}
        </Badge>
      ))}
    </span>
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
  ending: DEFAULT_ENDING,
  notes: '',
  editor_model: DEFAULT_EDITOR_MODEL,
  writer_model: DEFAULT_WRITER_MODEL,
  category_id: null
}

export function PremiseForm({ onSubmit, isSubmitting, defaultValues, mode = 'create' }: Props) {
  // 編集モードでは章数を減らせない (= 既に生成済みの章本文が宙ぶらりんになるため)。
  const minChapterCount =
    mode === 'edit' ? (typeof defaultValues?.num_chapters === 'number' ? defaultValues.num_chapters : 1) : 1
  const queryClient = useQueryClient()
  const { data: categories } = useSuspenseQuery({ queryKey: ['categories'], queryFn: () => api.listCategories() })
  const [newCategoryOpen, setNewCategoryOpen] = useState(false)
  const [newCategoryName, setNewCategoryName] = useState('')
  const [creatingCategory, setCreatingCategory] = useState(false)

  const form = useForm<CreateNovelInput>({
    resolver: zodResolver(CreateNovelSchema) as Resolver<CreateNovelInput>,
    defaultValues: defaultValues !== undefined ? defaultValues : EMPTY_DEFAULTS,
    mode: 'onSubmit'
  })

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
                  <span>
                    タイトル
                    <RequiredMark />
                  </span>
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
                  <span>
                    ジャンル
                    <RequiredMark />
                  </span>
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
                <FormLabel>カテゴリ</FormLabel>
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
                  物語に入れたいシーン・展開
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
                  <Select value={field.value} onValueChange={field.onChange}>
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
                    <ScopeTag scope='outline' />
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
