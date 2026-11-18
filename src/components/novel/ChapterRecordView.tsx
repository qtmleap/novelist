'use client'

import type { ReactNode } from 'react'
import type { ChapterRecord } from '@/schemas/story.dto'

// 章の記録の表示。後の章に「確定事項」として引き継がれる内容を、利用者が確かめるための読み取り専用の表示。
// 中身が空の項目は見出しごと出さない。

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className='space-y-1.5'>
      <h3 className='text-xs font-medium text-muted-foreground'>{title}</h3>
      {children}
    </section>
  )
}

// 同じ値が重なっても React のキーが衝突しないよう、値ごとの出現回数を足したキーを付ける。
// 添字をキーにしない (並びが変わると状態がずれるため)。
function withKeys<T>(items: T[], keyOf: (item: T) => string): { key: string; item: T }[] {
  const seen = new Map<string, number>()
  return items.map((item) => {
    const base = keyOf(item)
    const count = seen.get(base)
    const nth = count === undefined ? 0 : count + 1
    seen.set(base, nth)
    return { key: `${base}#${nth}`, item }
  })
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

export function ChapterRecordView({ record }: { record: ChapterRecord }) {
  const { summary, facts, characters, threads_opened, threads_resolved, end_state } = record
  const hasEndState = end_state.time !== '' || end_state.place !== '' || end_state.present.length > 0

  return (
    <div className='space-y-4 text-sm'>
      {summary !== '' && (
        <Section title='この章の流れ'>
          <p className='leading-relaxed'>{summary}</p>
        </Section>
      )}

      {facts.length > 0 && (
        <Section title='確定した事実'>
          <BulletList items={facts} />
        </Section>
      )}

      {characters.length > 0 && (
        <Section title='人物ごとの記録'>
          <div className='space-y-2'>
            {withKeys(characters, (c) => c.name).map(({ key, item: c }) => (
              <div key={key} className='space-y-2 rounded-md border bg-muted/30 p-3'>
                <h4 className='font-medium'>{c.name}</h4>
                {c.actions.length > 0 && (
                  <div className='space-y-0.5'>
                    <p className='text-xs text-muted-foreground'>したこと</p>
                    <BulletList items={c.actions} />
                  </div>
                )}
                {c.learned.length > 0 && (
                  <div className='space-y-0.5'>
                    <p className='text-xs text-muted-foreground'>知ったこと</p>
                    <BulletList items={c.learned} />
                  </div>
                )}
                {c.state !== '' && (
                  <div className='space-y-0.5'>
                    <p className='text-xs text-muted-foreground'>章末の状態</p>
                    <p className='leading-relaxed'>{c.state}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {threads_opened.length > 0 && (
        <Section title='張った伏線'>
          <ul className='list-disc space-y-0.5 pl-5'>
            {withKeys(threads_opened, (t) => t.id).map(({ key, item: t }) => (
              <li key={key}>
                {t.description}
                <span className='ml-1.5 font-mono text-xs text-muted-foreground'>{t.id}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {threads_resolved.length > 0 && (
        <Section title='回収した伏線'>
          <ul className='flex flex-wrap gap-x-3 gap-y-0.5'>
            {withKeys(threads_resolved, (id) => id).map(({ key, item: id }) => (
              <li key={key} className='font-mono text-xs'>
                {id}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {hasEndState && (
        <Section title='章末の状況'>
          <dl className='grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5'>
            {end_state.time !== '' && (
              <>
                <dt className='text-muted-foreground'>時</dt>
                <dd>{end_state.time}</dd>
              </>
            )}
            {end_state.place !== '' && (
              <>
                <dt className='text-muted-foreground'>場所</dt>
                <dd>{end_state.place}</dd>
              </>
            )}
            {end_state.present.length > 0 && (
              <>
                <dt className='text-muted-foreground'>その場にいる人物</dt>
                <dd>{end_state.present.join('・')}</dd>
              </>
            )}
          </dl>
        </Section>
      )}
    </div>
  )
}
