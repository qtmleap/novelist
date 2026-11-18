'use client'

import { TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import type { StoryBible } from '@/schemas/story.dto'

// 作品設計の表示。章立てと全章の本文に同じものが渡るので、利用者が中身を確かめるための読み取り専用の表示。
// 中身が空の項目は見出しごと出さない。

// 同じ値が重なっても React のキーが衝突しないよう、値ごとの出現回数を足したキーを付ける。
// 添字をキーにしない (Biome の noArrayIndexKey) ので、並びが変わらない一覧に限って使う。
// index は更新対象の行を指すために返す。
export function withKeys<T>(items: T[], keyOf: (item: T) => string): { key: string; item: T; index: number }[] {
  const seen = new Map<string, number>()
  return items.map((item, index) => {
    const base = keyOf(item)
    const count = seen.get(base)
    const nth = count === undefined ? 0 : count + 1
    seen.set(base, nth)
    return { key: `${base}#${nth}`, item, index }
  })
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className='space-y-1.5'>
      <h3 className='text-xs font-medium text-muted-foreground'>{title}</h3>
      {children}
    </section>
  )
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className='list-disc space-y-0.5 pl-5'>
      {withKeys(items, (item) => item).map(({ key, item }) => (
        <li key={key}>{item}</li>
      ))}
    </ul>
  )
}

// 作品設計を作った後に、あらすじか登場人物が変わったときの注意。失敗ではなく「確かめてほしい点」なので amber にし、
// 色だけに頼らずアイコンと文言でも伝える。小説ページのボタンの近くと、作品設計のダイアログの上部で使う。
export function BibleOutdatedNotice({ onOpen }: { onOpen?: () => void }) {
  return (
    <div className='flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200'>
      <TriangleAlert className='mt-0.5 size-5 shrink-0' aria-hidden='true' />
      <div className='flex min-w-0 flex-1 flex-col gap-2'>
        <p>作品設計を作った後に、あらすじか登場人物が変更されています。作り直すか、内容を確認してください。</p>
        {onOpen !== undefined && (
          <Button
            type='button'
            variant='outline'
            size='sm'
            onClick={onOpen}
            className='w-fit border-amber-500/40 bg-transparent text-amber-800 hover:bg-amber-500/20 hover:text-amber-800 dark:text-amber-200 dark:hover:text-amber-200'
          >
            作品設計を開く
          </Button>
        )}
      </div>
    </div>
  )
}

export function BibleView({ bible }: { bible: StoryBible }) {
  const { premise, ending, arcs, world, timeline, addresses, cast } = bible
  const isEmpty =
    premise === '' &&
    ending === '' &&
    arcs.length === 0 &&
    world.rules.length === 0 &&
    world.terms.length === 0 &&
    timeline.length === 0 &&
    addresses.length === 0 &&
    cast.length === 0

  if (isEmpty) return <p className='text-sm text-muted-foreground'>作品設計の内容はまだ空です。</p>

  return (
    <div className='space-y-4 text-sm'>
      {premise !== '' && (
        <Section title='物語の核'>
          <p className='whitespace-pre-wrap leading-relaxed'>{premise}</p>
        </Section>
      )}

      {ending !== '' && (
        <Section title='結末'>
          <p className='whitespace-pre-wrap leading-relaxed'>{ending}</p>
        </Section>
      )}

      {arcs.length > 0 && (
        <Section title='人物の変化'>
          <div className='space-y-2'>
            {withKeys(arcs, (a) => a.name).map(({ key, item: a }) => (
              <div key={key} className='space-y-1.5 rounded-md border bg-muted/30 p-3'>
                <h4 className='font-medium'>{a.name}</h4>
                {(a.start !== '' || a.end !== '') && (
                  <dl className='grid grid-cols-[auto_1fr] gap-x-3 gap-y-1'>
                    {a.start !== '' && (
                      <>
                        <dt className='text-xs text-muted-foreground'>始まり</dt>
                        <dd className='leading-relaxed'>{a.start}</dd>
                      </>
                    )}
                    {a.end !== '' && (
                      <>
                        <dt className='text-xs text-muted-foreground'>終わり</dt>
                        <dd className='leading-relaxed'>{a.end}</dd>
                      </>
                    )}
                  </dl>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {world.rules.length > 0 && (
        <Section title='世界のルール'>
          <BulletList items={world.rules} />
        </Section>
      )}

      {world.terms.length > 0 && (
        <Section title='用語'>
          <dl className='grid grid-cols-[auto_1fr] gap-x-3 gap-y-1'>
            {withKeys(world.terms, (t) => t.term).map(({ key, item: t }) => (
              <div key={key} className='contents'>
                <dt className='font-medium'>{t.term}</dt>
                <dd className='leading-relaxed text-muted-foreground'>{t.note}</dd>
              </div>
            ))}
          </dl>
        </Section>
      )}

      {timeline.length > 0 && (
        <Section title='時系列'>
          <BulletList items={timeline} />
        </Section>
      )}

      {addresses.length > 0 && (
        <Section title='呼称表'>
          <div className='overflow-auto rounded-md border'>
            <table className='w-full text-xs'>
              <thead className='bg-muted/40 text-left text-muted-foreground'>
                <tr>
                  <th scope='col' className='px-3 py-1.5 font-medium'>
                    呼ぶ人 → 呼ばれる人
                  </th>
                  <th scope='col' className='px-3 py-1.5 font-medium'>
                    呼び方
                  </th>
                </tr>
              </thead>
              <tbody className='divide-y'>
                {withKeys(addresses, (a) => `${a.from}>${a.to}`).map(({ key, item: a }) => (
                  <tr key={key}>
                    <td className='px-3 py-1.5'>
                      {a.from} → {a.to}
                    </td>
                    <td className='px-3 py-1.5'>{a.call}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {cast.length > 0 && (
        <Section title='成人としての人物設定'>
          <div className='space-y-2'>
            {withKeys(cast, (c) => c.name).map(({ key, item: c }) => (
              <div key={key} className='space-y-1.5 rounded-md border bg-muted/30 p-3'>
                <h4 className='font-medium'>{c.name}</h4>
                <dl className='grid grid-cols-[auto_1fr] gap-x-3 gap-y-1'>
                  {c.age !== '' && (
                    <>
                      <dt className='text-xs text-muted-foreground'>年齢</dt>
                      <dd>{c.age}</dd>
                    </>
                  )}
                  {c.occupation !== '' && (
                    <>
                      <dt className='text-xs text-muted-foreground'>職業</dt>
                      <dd>{c.occupation}</dd>
                    </>
                  )}
                  {c.appearance !== '' && (
                    <>
                      <dt className='text-xs text-muted-foreground'>外見</dt>
                      <dd className='whitespace-pre-wrap leading-relaxed'>{c.appearance}</dd>
                    </>
                  )}
                  {c.background !== '' && (
                    <>
                      <dt className='text-xs text-muted-foreground'>背景</dt>
                      <dd className='whitespace-pre-wrap leading-relaxed'>{c.background}</dd>
                    </>
                  )}
                </dl>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  )
}
