'use client'

import { Check, Loader2, Plus, Trash2, X } from 'lucide-react'
import { type ReactNode, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { withKeys } from '@/lib/keys'
import {
  type AddressEntry,
  type BibleCast,
  type StoryArc,
  type StoryBible,
  StoryBibleSchema
} from '@/schemas/story.dto'

// 作品設計の手動編集。素朴な作りにしている。
//   - 1 行 1 項目の欄 (世界のルール、時系列) は、保存のときに行で分けて空行を捨てる。
//   - 用語は行を足し引きできる。人物の変化、呼称表、成人の人物設定は、既にある行の値だけ直せる (行の追加・削除は無い)。

type TermRow = { rowId: number; term: string; note: string }

type Draft = {
  premise: string
  ending: string
  arcs: StoryArc[]
  rules: string
  terms: TermRow[]
  timeline: string
  addresses: AddressEntry[]
  cast: BibleCast[]
}

// 一覧の index 番目だけを書き換えた新しい配列を返す (state を直接変えない)。
function patchAt<T>(list: T[], index: number, change: Partial<T>): T[] {
  return list.map((item, i) => (i === index ? { ...item, ...change } : item))
}

const toLines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')

function toDraft(bible: StoryBible): Draft {
  return {
    premise: bible.premise,
    ending: bible.ending,
    arcs: bible.arcs,
    rules: bible.world.rules.join('\n'),
    terms: bible.world.terms.map((t, i) => ({ rowId: i, term: t.term, note: t.note })),
    timeline: bible.timeline.join('\n'),
    addresses: bible.addresses,
    cast: bible.cast
  }
}

// 検証に失敗した項目を利用者に伝えるための名前。
const FIELD_LABELS: Record<string, string> = {
  premise: '物語の核',
  ending: '結末',
  arcs: '人物の変化',
  world: '世界のルール・用語',
  timeline: '時系列',
  addresses: '呼称表',
  cast: '成人としての人物設定'
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className='space-y-1.5'>
      <Label htmlFor={id} className='text-xs font-medium text-muted-foreground'>
        {label}
      </Label>
      {children}
      {hint !== undefined && <p className='text-xs text-muted-foreground'>{hint}</p>}
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className='space-y-2'>
      <h3 className='text-sm font-semibold'>{title}</h3>
      {children}
    </section>
  )
}

type Props = {
  bible: StoryBible
  saving: boolean
  onSave: (bible: StoryBible) => Promise<void>
  onCancel: () => void
}

export function BibleEditor({ bible, saving, onSave, onCancel }: Props) {
  const uid = useId()
  const [draft, setDraft] = useState<Draft>(() => toDraft(bible))
  const [localError, setLocalError] = useState<string | null>(null)
  // 用語の行に振る id。足し引きしても、入力中の行の状態がずれないようにする。
  const nextRowId = useRef(bible.world.terms.length)

  const patch = (next: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...next }))

  const addTerm = () => {
    const rowId = nextRowId.current
    nextRowId.current += 1
    setDraft((prev) => ({ ...prev, terms: [...prev.terms, { rowId, term: '', note: '' }] }))
  }
  const removeTerm = (rowId: number) =>
    setDraft((prev) => ({ ...prev, terms: prev.terms.filter((t) => t.rowId !== rowId) }))
  const patchTerm = (rowId: number, change: Partial<TermRow>) =>
    setDraft((prev) => ({ ...prev, terms: prev.terms.map((t) => (t.rowId === rowId ? { ...t, ...change } : t)) }))

  const handleSave = async () => {
    setLocalError(null)
    // 用語は、用語も説明も空の行だけ捨てる。説明だけある行は、消えてしまわないよう保存せずに知らせる。
    const filledTerms = draft.terms.filter((t) => t.term.trim() !== '' || t.note.trim() !== '')
    if (filledTerms.some((t) => t.term.trim() === '')) {
      setLocalError('用語が空の行があります。用語を入力するか、その行を削除してください')
      return
    }
    if (draft.addresses.some((a) => a.call.trim() === '')) {
      setLocalError('呼称表に、呼び方が空の行があります')
      return
    }
    const parsed = StoryBibleSchema.safeParse({
      premise: draft.premise.trim(),
      ending: draft.ending.trim(),
      arcs: draft.arcs,
      world: {
        rules: toLines(draft.rules),
        terms: filledTerms.map((t) => ({ term: t.term.trim(), note: t.note.trim() }))
      },
      timeline: toLines(draft.timeline),
      addresses: draft.addresses.map((a) => ({ ...a, call: a.call.trim() })),
      cast: draft.cast
    })
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      const key = first !== undefined ? first.path[0] : undefined
      const label = typeof key === 'string' && key in FIELD_LABELS ? FIELD_LABELS[key] : '作品設計'
      setLocalError(`「${label}」の内容が上限を超えています。短くしてから保存してください`)
      return
    }
    await onSave(parsed.data)
  }

  return (
    <div className='space-y-3'>
      <div className='max-h-[55vh] space-y-6 overflow-auto pr-1'>
        <Group title='物語の核と結末'>
          <Field id={`${uid}-premise`} label='物語の核'>
            <Textarea
              id={`${uid}-premise`}
              value={draft.premise}
              onChange={(e) => patch({ premise: e.target.value })}
              maxLength={3000}
              className='text-sm'
            />
          </Field>
          <Field id={`${uid}-ending`} label='結末'>
            <Textarea
              id={`${uid}-ending`}
              value={draft.ending}
              onChange={(e) => patch({ ending: e.target.value })}
              maxLength={3000}
              className='text-sm'
            />
          </Field>
        </Group>

        {draft.arcs.length > 0 && (
          <Group title='人物の変化'>
            <div className='space-y-2'>
              {withKeys(draft.arcs, (a) => a.name).map(({ key, item: a, index }) => (
                <div key={key} className='space-y-2 rounded-md border bg-muted/30 p-3'>
                  <p className='text-sm font-medium'>{a.name}</p>
                  <Textarea
                    aria-label={`${a.name} の始まり`}
                    placeholder='始まり'
                    value={a.start}
                    onChange={(e) => patch({ arcs: patchAt(draft.arcs, index, { start: e.target.value }) })}
                    maxLength={800}
                    className='text-sm'
                  />
                  <Textarea
                    aria-label={`${a.name} の終わり`}
                    placeholder='終わり'
                    value={a.end}
                    onChange={(e) => patch({ arcs: patchAt(draft.arcs, index, { end: e.target.value }) })}
                    maxLength={800}
                    className='text-sm'
                  />
                </div>
              ))}
            </div>
          </Group>
        )}

        <Group title='世界のルールと用語'>
          <Field id={`${uid}-rules`} label='世界のルール' hint='1 行に 1 項目ずつ書きます。空行は無視されます。'>
            <Textarea
              id={`${uid}-rules`}
              value={draft.rules}
              onChange={(e) => patch({ rules: e.target.value })}
              className='text-sm'
            />
          </Field>
          <div className='space-y-2'>
            <p className='text-xs font-medium text-muted-foreground'>用語</p>
            {draft.terms.map((t) => (
              <div key={t.rowId} className='flex flex-col gap-2 sm:flex-row sm:items-start'>
                <Input
                  aria-label='用語'
                  placeholder='用語'
                  value={t.term}
                  onChange={(e) => patchTerm(t.rowId, { term: e.target.value })}
                  maxLength={100}
                  className='text-sm sm:w-44 sm:shrink-0'
                />
                <Input
                  aria-label='説明'
                  placeholder='説明'
                  value={t.note}
                  onChange={(e) => patchTerm(t.rowId, { note: e.target.value })}
                  maxLength={600}
                  className='text-sm sm:flex-1'
                />
                <Button
                  type='button'
                  variant='ghost'
                  size='icon'
                  aria-label='この用語を削除'
                  onClick={() => removeTerm(t.rowId)}
                  className='shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive'
                >
                  <Trash2 className='size-4' />
                </Button>
              </div>
            ))}
            <Button type='button' variant='outline' size='sm' onClick={addTerm} className='[&_svg]:size-4!'>
              <Plus />
              用語を追加
            </Button>
          </div>
        </Group>

        <Group title='時系列'>
          <Field id={`${uid}-timeline`} label='時系列' hint='1 行に 1 項目ずつ書きます。空行は無視されます。'>
            <Textarea
              id={`${uid}-timeline`}
              value={draft.timeline}
              onChange={(e) => patch({ timeline: e.target.value })}
              className='text-sm'
            />
          </Field>
        </Group>

        {draft.addresses.length > 0 && (
          <Group title='呼称表'>
            <p className='text-xs text-muted-foreground'>呼び方だけ直せます。</p>
            <div className='space-y-2'>
              {withKeys(draft.addresses, (a) => `${a.from}>${a.to}`).map(({ key, item: a, index }) => (
                <div key={key} className='flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3'>
                  <span className='text-sm sm:w-56 sm:shrink-0'>
                    {a.from} → {a.to}
                  </span>
                  <Input
                    aria-label={`${a.from} が ${a.to} を呼ぶ呼び方`}
                    value={a.call}
                    onChange={(e) => patch({ addresses: patchAt(draft.addresses, index, { call: e.target.value }) })}
                    maxLength={60}
                    className='text-sm sm:flex-1'
                  />
                </div>
              ))}
            </div>
          </Group>
        )}

        {draft.cast.length > 0 && (
          <Group title='成人としての人物設定'>
            <div className='space-y-2'>
              {withKeys(draft.cast, (c) => c.name).map(({ key, item: c, index }) => (
                <div key={key} className='space-y-2 rounded-md border bg-muted/30 p-3'>
                  <p className='text-sm font-medium'>{c.name}</p>
                  <div className='grid gap-2 sm:grid-cols-2'>
                    <div className='space-y-1'>
                      <Input
                        aria-label={`${c.name} の年齢`}
                        placeholder='年齢'
                        inputMode='numeric'
                        value={c.age}
                        onChange={(e) => patch({ cast: patchAt(draft.cast, index, { age: e.target.value }) })}
                        maxLength={50}
                        className='text-sm'
                      />
                      <p className='text-xs text-muted-foreground'>18 以上の数字で入力してください</p>
                    </div>
                    <Input
                      aria-label={`${c.name} の職業`}
                      placeholder='職業'
                      value={c.occupation}
                      onChange={(e) => patch({ cast: patchAt(draft.cast, index, { occupation: e.target.value }) })}
                      maxLength={100}
                      className='text-sm'
                    />
                  </div>
                  <Textarea
                    aria-label={`${c.name} の外見`}
                    placeholder='外見'
                    value={c.appearance}
                    onChange={(e) => patch({ cast: patchAt(draft.cast, index, { appearance: e.target.value }) })}
                    maxLength={2000}
                    className='text-sm'
                  />
                  <Textarea
                    aria-label={`${c.name} の背景`}
                    placeholder='背景'
                    value={c.background}
                    onChange={(e) => patch({ cast: patchAt(draft.cast, index, { background: e.target.value }) })}
                    maxLength={4000}
                    className='text-sm'
                  />
                </div>
              ))}
            </div>
          </Group>
        )}
      </div>

      {localError !== null && (
        <p role='alert' className='text-sm text-destructive'>
          {localError}
        </p>
      )}

      <div className='flex justify-end gap-2'>
        <Button
          type='button'
          variant='ghost'
          size='sm'
          disabled={saving}
          onClick={onCancel}
          className='[&_svg]:size-5!'
        >
          <X />
          キャンセル
        </Button>
        <Button type='button' size='sm' disabled={saving} onClick={handleSave} className='[&_svg]:size-5!'>
          {saving ? <Loader2 className='animate-spin' /> : <Check />}
          保存
        </Button>
      </div>
    </div>
  )
}
