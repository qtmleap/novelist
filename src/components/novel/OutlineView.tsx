'use client'

import { BookMarked, Check, ChevronRight, ListChecks, Loader2, Pencil, TriangleAlert, Users, X } from 'lucide-react'
import Link from 'next/link'
import { type ReactNode, useEffect, useState } from 'react'
import { MultiSelect } from '@/components/MultiSelect'
import { type ChapterData, STALE_REASON_LABELS } from '@/components/novel/ChapterReader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { withKeys } from '@/lib/keys'
import { routes } from '@/lib/routes'
import { cn } from '@/lib/utils'
import { type ChapterCost, type Outline, type OutlineChapter, OutlineSchema } from '@/schemas/novel.dto'
import type { StoryThread } from '@/schemas/story.dto'

// 章ごとの検査の警告の件数。checks = 機械的な検査、issues = 内容の矛盾の指摘。
export type ReviewCounts = { checks: number; issues: number }

type Props = {
  outline: Outline | null
  isGenerating: boolean
  regenerateSlot?: ReactNode
  isBusy?: boolean
  chapters: ChapterData[]
  // 章番号 → 検査の警告の件数。無い章、または 0 件の章には「確認」の印を出さない。
  reviewCounts?: ReadonlyMap<number, ReviewCounts>
  costs: ChapterCost[]
  streamingIndex?: number | null
  // 生成済みの章を押したときの遷移先 (例: /novels/[id]/chapters/[number])。
  novelId?: string
  // novel.num_chapters。outline がまだ無い章や、outline 枠を上回る章数を持つ novel でも
  // 全章ぶんの枠を表示するため、明示で渡してもらう。
  expectedTotal?: number
  // 手動編集のセーブ。未指定なら編集ボタンは出さない。
  // 既存 chapter_number の集合は維持し、title/summary/characters と章の計画 (時と場所、出来事、章末の状況) だけ
  // 変更される。伏線 (setups/payoffs) は編集できず、値をそのまま保存する。
  onSaveOutline?: (outline: Outline) => Promise<void>
  // 編集を許可するか (= 認証済かつ生成中でない)。
  canEdit?: boolean
  // 小説の名簿の名前。編集モードで各章の登場人物を選ぶ候補になる。空なら登場人物の欄は出さない。
  castNames?: string[]
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

const hasPlan = (ch: OutlineChapter): boolean =>
  ch.events.length > 0 || ch.time_place !== '' || ch.end_state !== '' || ch.setups.length > 0 || ch.payoffs.length > 0

// 1 行 1 項目の欄を保存用に整える。前後の空白を落として、空行を捨てる。
const toLines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')

// 本文はあるが、生成した後に上流 (章立て、前の章) が変わった章の印。色だけに頼らず、アイコンと文言も付ける。
// 理由は title (マウスを載せたとき) と aria-label (読み上げ) の両方に入れる。
function StaleBadge({ reasons }: { reasons: ChapterData['staleReasons'] }) {
  const detail = reasons.map((r) => STALE_REASON_LABELS[r])
  return (
    <Badge
      variant='outline'
      role='img'
      title={detail.join('\n')}
      aria-label={detail.length > 0 ? `要再生成: ${detail.join('、')}` : '要再生成'}
      className='border-amber-500/40 bg-amber-500/10 font-normal text-amber-800 dark:text-amber-200'
    >
      <TriangleAlert aria-hidden='true' />
      要再生成
    </Badge>
  )
}

// 本文はあるが、検査で確認してほしい点が見つかった章の印。「要再生成」(amber の塗り) とは別に、枠だけの体裁にする。
// 内訳は title と aria-label に入れる。検査は AI の判定を含み誤りがありうるので、「警告」ではなく「確認」と呼ぶ。
function ReviewBadge({ counts }: { counts: ReviewCounts }) {
  const total = counts.checks + counts.issues
  const parts = [
    counts.issues > 0 ? `内容の矛盾 ${counts.issues} 件` : '',
    counts.checks > 0 ? `機械的な検査 ${counts.checks} 件` : ''
  ].filter((p) => p !== '')
  const detail = parts.join('・')
  return (
    <Badge
      variant='outline'
      role='img'
      title={detail}
      aria-label={`検査で確認事項が ${total} 件: ${detail}`}
      className='font-normal text-muted-foreground'
    >
      <ListChecks aria-hidden='true' />
      確認 <span className='tabular-nums'>{total}</span>
    </Badge>
  )
}

// 章ごとの計画 (出来事、時と場所、章末の状況、伏線)。情報が多く一覧が長くなるので、既定は閉じる。
// 行全体が章ページへのリンクのことがあるため、リンクの外 (行の下) に置く。
function ChapterPlan({ chapter, setupById }: { chapter: OutlineChapter; setupById: Map<string, StoryThread> }) {
  if (!hasPlan(chapter)) return null
  const counts = [
    chapter.events.length > 0 ? `出来事 ${chapter.events.length}` : '',
    chapter.setups.length > 0 ? `伏線 ${chapter.setups.length}` : '',
    chapter.payoffs.length > 0 ? `回収 ${chapter.payoffs.length}` : ''
  ].filter((c) => c !== '')
  return (
    <details className='-mt-1.5 pr-4 pb-3 pl-[3.25rem] text-xs'>
      <summary className='w-fit cursor-pointer select-none text-muted-foreground hover:text-foreground'>
        章の計画
        {counts.length > 0 && <span className='ml-2 tabular-nums'>{counts.join('・')}</span>}
      </summary>
      <dl className='mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 leading-relaxed'>
        {chapter.time_place !== '' && (
          <>
            <dt className='text-muted-foreground'>時と場所</dt>
            <dd>{chapter.time_place}</dd>
          </>
        )}
        {chapter.events.length > 0 && (
          <>
            <dt className='text-muted-foreground'>出来事</dt>
            <dd>
              <ol className='list-decimal space-y-0.5 pl-4'>
                {withKeys(chapter.events, (e) => e).map(({ key, item }) => (
                  <li key={key}>{item}</li>
                ))}
              </ol>
            </dd>
          </>
        )}
        {chapter.end_state !== '' && (
          <>
            <dt className='text-muted-foreground'>章末の状況</dt>
            <dd>{chapter.end_state}</dd>
          </>
        )}
        {chapter.setups.length > 0 && (
          <>
            <dt className='text-muted-foreground'>張る伏線</dt>
            <dd>
              <ul className='space-y-0.5'>
                {withKeys(chapter.setups, (t) => t.id).map(({ key, item: t }) => (
                  <li key={key}>
                    {t.description}
                    <span className='ml-1.5 font-mono text-muted-foreground'>{t.id}</span>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
        {chapter.payoffs.length > 0 && (
          <>
            <dt className='text-muted-foreground'>回収する伏線</dt>
            <dd>
              <ul className='space-y-0.5'>
                {withKeys(chapter.payoffs, (id) => id).map(({ key, item: id }) => {
                  // 説明は章立て全体の setups から id で引く。引けなければ id だけ出す。
                  const setup = setupById.get(id)
                  return (
                    <li key={key}>
                      <span className='font-mono'>{id}</span>
                      {setup !== undefined && <span className='ml-1.5 text-muted-foreground'>{setup.description}</span>}
                    </li>
                  )
                })}
              </ul>
            </dd>
          </>
        )}
      </dl>
    </details>
  )
}

export function OutlineView({
  outline,
  isGenerating,
  regenerateSlot,
  chapters,
  reviewCounts,
  costs,
  streamingIndex = null,
  novelId,
  expectedTotal = 0,
  onSaveOutline,
  canEdit = false,
  castNames = []
}: Props) {
  // 編集モード中だけ使う一時 outline。読み取り専用ビューと、保存中の loading 状態を別途持つ。
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Outline['chapters']>([])
  const [saving, setSaving] = useState(false)
  // 保存前の検査 (文字数の上限など) で止めたときの理由。
  const [saveError, setSaveError] = useState<string | null>(null)

  // outline (prop) が外から変わったら draft も追従させる (再生成後など)。
  // 編集中の差分は捨てる: 衝突するくらいなら最新を採用する方針。
  useEffect(() => {
    setDraft(outline !== null ? outline.chapters : [])
  }, [outline])

  const chapterByNumber = new Map<number, ChapterData>()
  for (const c of chapters) chapterByNumber.set(c.number, c)
  const costByNumber = new Map<number, ChapterCost>()
  for (const c of costs) costByNumber.set(c.chapter_number, c)
  const outlineByNumber = new Map<number, Outline['chapters'][number]>()
  for (const ch of outline !== null ? outline.chapters : []) outlineByNumber.set(ch.chapter_number, ch)
  // 回収する伏線の説明を引くための、章立て全体の伏線 (id → 伏線)。
  const setupById = new Map<string, StoryThread>()
  for (const ch of outline !== null ? outline.chapters : []) for (const t of ch.setups) setupById.set(t.id, t)

  // 表示対象は outline の章番号 + novel.num_chapters まで。
  // どちらも 0 のときは何も出さない。
  const maxNumber = Math.max(
    expectedTotal,
    ...Array.from(outlineByNumber.keys()),
    streamingIndex !== null ? streamingIndex : 0
  )
  if (maxNumber === 0 && !isGenerating) return null
  const slots = Array.from({ length: maxNumber }, (_, i) => i + 1)

  const editableSaveable = onSaveOutline !== undefined && canEdit && !isGenerating

  const handleStartEdit = () => {
    setDraft(outline !== null ? outline.chapters : [])
    setSaveError(null)
    setEditing(true)
  }
  const handleCancelEdit = () => {
    setDraft(outline !== null ? outline.chapters : [])
    setSaveError(null)
    setEditing(false)
  }
  const handleSave = async () => {
    if (onSaveOutline === undefined) return
    setSaveError(null)
    // 出来事の欄は入力中に空行を残したいので draft には行をそのまま持ち、保存のときに整える。
    // 伏線 (setups/payoffs) は編集できないので、draft の値をそのまま渡す。
    const parsed = OutlineSchema.safeParse({
      chapters: draft.map((c) => ({
        ...c,
        time_place: c.time_place.trim(),
        end_state: c.end_state.trim(),
        events: toLines(c.events.join('\n'))
      }))
    })
    if (!parsed.success) {
      setSaveError('章の計画が長すぎます。出来事は 20 個まで、1 つ 1,000 字までにしてください')
      return
    }
    setSaving(true)
    try {
      await onSaveOutline(parsed.data)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }
  const updateDraft = (number: number, patch: Partial<Outline['chapters'][number]>) => {
    setDraft((prev) => prev.map((c) => (c.chapter_number === number ? { ...c, ...patch } : c)))
  }
  // 登場人物の選択肢は名簿の順。名簿に無い名前が章に残っている場合 (人物名を後から変えたときなど) も、
  // 利用者が外せるよう末尾に足す。
  const characterOptionsFor = (characters: string[]): string[] =>
    Array.from(new Set([...castNames, ...characters.filter((name) => !castNames.includes(name))]))
  // 本文生成はこの名前で人物設定を絞るので、選択結果は選択肢の並び (= 名簿順) に揃えて保存する。
  const toggleCharacter = (number: number, current: string[], options: string[], name: string) => {
    const next = current.includes(name) ? current.filter((c) => c !== name) : [...current, name]
    updateDraft(number, { characters: options.filter((o) => next.includes(o)) })
  }

  return (
    <div className='space-y-3'>
      <div className='flex items-center justify-between gap-2'>
        <div className='flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground'>
          <BookMarked className='size-5 text-primary' />
          {isGenerating && !outline ? '章立て生成中...' : '章立て'}
        </div>
        {editing ? (
          <div className='flex items-center gap-2'>
            <Button
              type='button'
              size='sm'
              variant='ghost'
              className='[&_svg]:size-5!'
              disabled={saving}
              onClick={handleCancelEdit}
            >
              <X />
              キャンセル
            </Button>
            <Button
              type='button'
              size='sm'
              className='[&_svg]:size-5!'
              disabled={saving || draft.length === 0}
              onClick={handleSave}
            >
              {saving ? <Loader2 className='animate-spin' /> : <Check />}
              保存
            </Button>
          </div>
        ) : (
          <div className='flex items-center gap-2'>
            {editableSaveable && outline !== null && outline.chapters.length > 0 && (
              <Button type='button' size='sm' variant='outline' className='[&_svg]:size-5!' onClick={handleStartEdit}>
                <Pencil />
                編集
              </Button>
            )}
            {regenerateSlot}
          </div>
        )}
      </div>
      {saveError !== null && (
        <p role='alert' className='text-sm text-destructive'>
          {saveError}
        </p>
      )}
      <ol className='divide-y border-y'>
        {slots.map((n) => {
          const ch = outlineByNumber.get(n)
          const chapterData = chapterByNumber.get(n)
          const done = chapterData?.done === true
          const isStreaming = streamingIndex === n
          const linkable = done && novelId !== undefined && !editing
          const cost = costByNumber.get(n)
          const reviewCount = reviewCounts !== undefined ? reviewCounts.get(n) : undefined
          const hasOutlineEntry = ch !== undefined
          const draftChapter = draft.find((d) => d.chapter_number === n)
          // 編集モードでは draft のエントリだけを並べる (outline.chapters の中身を直接いじる)。
          // outline 未生成の slot は編集対象に含めない (= 章立て生成側で増やす流れ)。
          if (editing && draftChapter !== undefined) {
            const characterOptions = characterOptionsFor(draftChapter.characters)
            return (
              <li key={n} className='flex items-start gap-3 px-4 py-3'>
                <span className='mt-1 flex size-6 shrink-0 items-center justify-center rounded bg-muted text-xs font-semibold tabular-nums text-muted-foreground'>
                  {n}
                </span>
                <div className='min-w-0 flex-1 space-y-2'>
                  <Input
                    value={draftChapter.title}
                    onChange={(e) => updateDraft(n, { title: e.target.value })}
                    placeholder='章タイトル'
                    className='text-sm'
                  />
                  <Textarea
                    value={draftChapter.summary}
                    onChange={(e) => updateDraft(n, { summary: e.target.value })}
                    placeholder='章の概要'
                    rows={3}
                    className='resize-none text-xs leading-relaxed'
                  />
                  {castNames.length > 0 && (
                    <div className='space-y-1'>
                      <p className='flex items-center gap-1.5 text-xs font-medium text-muted-foreground'>
                        <Users className='size-3.5 shrink-0' aria-hidden='true' />
                        登場人物
                      </p>
                      <MultiSelect
                        options={characterOptions}
                        selected={draftChapter.characters}
                        onToggle={(name) => toggleCharacter(n, draftChapter.characters, characterOptions, name)}
                        placeholder='登場人物を選択'
                        ariaLabel={`第 ${n} 章の登場人物`}
                        className='text-sm'
                      />
                      {/* 章の登場人物が空だと旧データと同じ扱いになり、本文の生成で名簿の全員の設定が載る。 */}
                      {draftChapter.characters.length === 0 && (
                        <p className='text-xs text-muted-foreground'>
                          未選択のままにすると、本文の生成では名簿の全員が登場する扱いになります
                        </p>
                      )}
                    </div>
                  )}
                  <div className='space-y-1'>
                    <Label htmlFor={`outline-${n}-time-place`} className='text-xs font-medium text-muted-foreground'>
                      時と場所
                    </Label>
                    <Input
                      id={`outline-${n}-time-place`}
                      value={draftChapter.time_place}
                      onChange={(e) => updateDraft(n, { time_place: e.target.value })}
                      maxLength={1000}
                      className='text-sm'
                    />
                  </div>
                  <div className='space-y-1'>
                    <Label htmlFor={`outline-${n}-events`} className='text-xs font-medium text-muted-foreground'>
                      出来事
                    </Label>
                    <Textarea
                      id={`outline-${n}-events`}
                      value={draftChapter.events.join('\n')}
                      // 入力中に空行を消すと改行できないので、行で分けるだけにして、整えるのは保存のとき。
                      onChange={(e) => updateDraft(n, { events: e.target.value.split('\n') })}
                      placeholder='1 行に 1 つずつ書きます'
                      rows={4}
                      className='resize-none text-xs leading-relaxed'
                    />
                  </div>
                  <div className='space-y-1'>
                    <Label htmlFor={`outline-${n}-end-state`} className='text-xs font-medium text-muted-foreground'>
                      章末の状況
                    </Label>
                    <Textarea
                      id={`outline-${n}-end-state`}
                      value={draftChapter.end_state}
                      onChange={(e) => updateDraft(n, { end_state: e.target.value })}
                      placeholder='誰がどこでどういう状態か'
                      rows={2}
                      maxLength={2000}
                      className='resize-none text-xs leading-relaxed'
                    />
                  </div>
                </div>
              </li>
            )
          }
          const rowContent = (
            <>
              <span className='flex size-6 shrink-0 items-center justify-center rounded bg-muted text-xs font-semibold tabular-nums text-muted-foreground'>
                {n}
              </span>
              <div className='min-w-0 flex-1'>
                <p className='flex items-center gap-1.5 font-medium text-sm leading-snug'>
                  {hasOutlineEntry ? (
                    ch.title
                  ) : (
                    <span className='font-normal italic text-muted-foreground'>未生成</span>
                  )}
                  {isStreaming ? (
                    <Loader2 className='size-3.5 shrink-0 animate-spin text-primary' />
                  ) : done ? (
                    <Check
                      strokeWidth={3}
                      className='size-4 shrink-0 text-emerald-500 dark:text-emerald-400'
                      aria-label='本文あり'
                    />
                  ) : null}
                  {done && chapterData?.stale === true && <StaleBadge reasons={chapterData.staleReasons} />}
                  {done && reviewCount !== undefined && reviewCount.checks + reviewCount.issues > 0 && (
                    <ReviewBadge counts={reviewCount} />
                  )}
                </p>
                {hasOutlineEntry ? (
                  <p className='mt-0.5 text-xs leading-relaxed text-muted-foreground'>{ch.summary}</p>
                ) : (
                  <p className='mt-0.5 text-xs italic leading-relaxed text-muted-foreground/60'>
                    章立てがまだ生成されていません
                  </p>
                )}
                {hasOutlineEntry && ch.characters.length > 0 && (
                  <div className='mt-1.5 flex flex-wrap items-center gap-1'>
                    <Users className='size-3.5 shrink-0 text-muted-foreground' aria-label='登場人物' />
                    {ch.characters.map((name) => (
                      <Badge key={name} variant='secondary' className='font-normal'>
                        {name}
                      </Badge>
                    ))}
                  </div>
                )}
                {done && chapterData && (
                  <div className='mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground'>
                    <span>{chapterData.content.length.toLocaleString()} 文字</span>
                    {cost && (
                      <>
                        <span className='truncate'>{cost.model}</span>
                        <span>
                          入力{fmtTokens(cost.prompt_tokens)} / 出力{fmtTokens(cost.output_tokens)}
                        </span>
                        <span>${cost.cost_usd.toFixed(4)} USD</span>
                      </>
                    )}
                  </div>
                )}
              </div>
              {linkable && <ChevronRight className='size-5 shrink-0 self-center text-muted-foreground' />}
            </>
          )
          const className = cn(
            'flex items-start gap-3 px-4 py-3 transition-colors',
            linkable && 'hover:bg-muted/40',
            !hasOutlineEntry && 'opacity-70'
          )
          return (
            <li key={n} className='contents'>
              {linkable ? (
                <Link href={routes.novels.chapter(novelId, n)} className={className}>
                  {rowContent}
                </Link>
              ) : (
                <div className={className}>{rowContent}</div>
              )}
              {ch !== undefined && <ChapterPlan chapter={ch} setupById={setupById} />}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
