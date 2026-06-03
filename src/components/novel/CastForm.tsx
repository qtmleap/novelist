'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useSuspenseQuery } from '@tanstack/react-query'
import { Loader2, Plus, Save, Trash2, UserPlus } from 'lucide-react'
import { type Resolver, useFieldArray, useForm } from 'react-hook-form'
import { Button } from '@/components/ui/button'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api/client'
import { routes } from '@/lib/routes'
import { ADDRESS_STYLES, CHARACTER_ROLES, type Character } from '@/schemas/character.dto'
import { FOCAL_POVS, RELATION_TYPES, type SaveCastInput, SaveCastSchema } from '@/schemas/novel.dto'

type Props = {
  // 小説の視点 (語り手セレクトを出すか判定するのに使う)。
  pov: string
  defaultValues: SaveCastInput
  onSubmit: (data: SaveCastInput) => Promise<void>
  isSubmitting?: boolean
}

export function CastForm({ pov, defaultValues, onSubmit, isSubmitting = false }: Props) {
  const { data: dictionary } = useSuspenseQuery({
    queryKey: ['characters'],
    queryFn: () => api.listCharacters()
  })

  const form = useForm<SaveCastInput>({
    resolver: zodResolver(SaveCastSchema) as Resolver<SaveCastInput>,
    defaultValues,
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

  const selectedIds = new Set(characterLinks.map((l) => l.character_id).filter(Boolean))
  const castCharacters = characterLinks
    .map((l) => dictionary.find((c) => c.id === l.character_id))
    .filter((c): c is Character => c !== undefined)

  const canAddRelation = castCharacters.length >= 2
  const showNarratorSelect = FOCAL_POVS.includes(pov) && castCharacters.length > 0

  const submit = form.handleSubmit(onSubmit)

  return (
    <Form {...form}>
      <form onSubmit={submit} className='space-y-8'>
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

        {/* ── 語り手 ── */}
        {showNarratorSelect && (
          <FormField
            control={form.control}
            name='pov_character_id'
            render={({ field }) => (
              <FormItem className='space-y-2'>
                <FormLabel>語り手（視点人物）</FormLabel>
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
                        <span className='shrink-0 text-xs text-muted-foreground'>→</span>
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
          {isSubmitting ? <Loader2 className='animate-spin' /> : <Save />}
          保存する
        </Button>
      </form>
    </Form>
  )
}
