'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2, Plus, Save, Trash2 } from 'lucide-react'
import { type DefaultValues, type Resolver, useFieldArray, useForm } from 'react-hook-form'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  ADDRESS_STYLES,
  type CreateCharacterInput,
  CreateCharacterSchema,
  FIRST_PERSON_OPTIONS,
  GENDER_OPTIONS,
  OCCUPATION_OPTIONS
} from '@/schemas/character.dto'

type Props = {
  defaultValues?: DefaultValues<CreateCharacterInput>
  submitLabel: string
  onSubmit: (data: CreateCharacterInput) => Promise<void>
  isSubmitting?: boolean
}

const FormSchema = CreateCharacterSchema.extend({
  speech_examples: z
    .array(z.object({ value: z.string().max(300) }))
    .max(20)
    .default([]),
  // バリエーション。口調は 1 行 1 例の textarea で持ち、送信時に配列へ分解する。
  variants: z
    .array(
      z.object({
        label: z.string().max(50),
        age: z.string().max(50).default(''),
        occupation: z.string().max(50).default(''),
        appearance: z.string().max(2000).default(''),
        first_person: z.string().max(20).default(''),
        address_others: z.string().max(500).default(''),
        description: z.string().max(4000).default(''),
        speech: z.string().max(6200).default('')
      })
    )
    .max(20)
    .default([])
})
type FormValues = z.infer<typeof FormSchema>

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

// CharacterVariantInput[] (speech_examples: string[]) → フォーム形 (speech: 改行結合) へ。
// DefaultValues はネストが Partial になるので各フィールドを明示的に narrow する。
function toFormVariants(variants: DefaultValues<CreateCharacterInput>['variants']): FormValues['variants'] {
  const list = Array.isArray(variants) ? variants : []
  return list.map((s) => {
    const speech = Array.isArray(s?.speech_examples)
      ? s.speech_examples.filter((v): v is string => typeof v === 'string')
      : []
    return {
      label: str(s?.label),
      age: str(s?.age),
      occupation: str(s?.occupation),
      appearance: str(s?.appearance),
      first_person: str(s?.first_person),
      address_others: str(s?.address_others),
      description: str(s?.description),
      speech: speech.join('\n')
    }
  })
}

export function CharacterForm({ defaultValues, submitLabel, onSubmit, isSubmitting = false }: Props) {
  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema) as Resolver<FormValues>,
    defaultValues: {
      name: '',
      gender: '',
      age: '',
      occupation: '',
      appearance: '',
      first_person: '',
      address_others: '',
      speech_examples: (defaultValues?.speech_examples ? defaultValues.speech_examples : [])
        .filter((v): v is string => typeof v === 'string')
        .map((v) => ({ value: v })),
      description: '',
      variants: toFormVariants(defaultValues?.variants),
      ...Object.fromEntries(
        Object.entries(defaultValues ? defaultValues : {}).filter(([k]) => k !== 'speech_examples' && k !== 'variants')
      )
    },
    mode: 'onSubmit'
  })

  const { fields, append, remove } = useFieldArray<FormValues, 'speech_examples'>({
    control: form.control,
    name: 'speech_examples'
  })

  const {
    fields: variantFields,
    append: appendVariant,
    remove: removeVariant
  } = useFieldArray<FormValues, 'variants'>({ control: form.control, name: 'variants' })

  const handleSubmit = form.handleSubmit((data) => {
    const flattened: CreateCharacterInput = {
      ...data,
      speech_examples: data.speech_examples.map((r) => r.value).filter((v) => v.trim() !== ''),
      // バリエーション名が空の行は捨てる。口調は改行で分割して空行を除く。
      variants: data.variants
        .filter((s) => s.label.trim() !== '')
        .map((s) => ({
          label: s.label.trim(),
          age: s.age,
          occupation: s.occupation,
          appearance: s.appearance,
          first_person: s.first_person,
          address_others: s.address_others,
          description: s.description,
          speech_examples: s.speech
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '')
        }))
    }
    return onSubmit(flattened)
  })

  return (
    <Form {...form}>
      <form onSubmit={handleSubmit} className='space-y-5'>
        <div className='space-y-4'>
          <div className='grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_10rem_8rem]'>
            <FormField
              control={form.control}
              name='name'
              render={({ field }) => (
                <FormItem className='space-y-2'>
                  <FormLabel>
                    名前 <span className='text-destructive'>*</span>
                  </FormLabel>
                  <FormControl>
                    <Input placeholder='例: ルカ' {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name='gender'
              render={({ field }) => (
                <FormItem className='space-y-2'>
                  <FormLabel>性別</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className='w-full'>
                        <SelectValue placeholder='選択（任意）' />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {GENDER_OPTIONS.map((g) => (
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
              name='age'
              render={({ field }) => (
                <FormItem className='space-y-2'>
                  <FormLabel>年齢</FormLabel>
                  <FormControl>
                    <Input placeholder='例: 17歳' {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name='appearance'
            render={({ field }) => (
              <FormItem className='space-y-2'>
                <FormLabel>外見</FormLabel>
                <FormControl>
                  <Textarea
                    placeholder='例: 銀色の長髪、青い瞳、細身の体格'
                    rows={3}
                    className='resize-none'
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className='grid grid-cols-1 gap-4 sm:grid-cols-3'>
            <FormField
              control={form.control}
              name='occupation'
              render={({ field }) => (
                <FormItem className='space-y-2'>
                  <FormLabel>職業</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className='w-full'>
                        <SelectValue placeholder='選択（任意）' />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {OCCUPATION_OPTIONS.map((o) => (
                        <SelectItem key={o} value={o}>
                          {o}
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
              name='first_person'
              render={({ field }) => (
                <FormItem className='space-y-2'>
                  <FormLabel>一人称</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className='w-full'>
                        <SelectValue placeholder='選択（任意）' />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {FIRST_PERSON_OPTIONS.map((p) => (
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
              name='address_others'
              render={({ field }) => (
                <FormItem className='space-y-2'>
                  <FormLabel>他の人への呼び方</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className='w-full'>
                        <SelectValue placeholder='呼び方を選択（任意）' />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {ADDRESS_STYLES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <div className='space-y-2'>
            <p className='text-sm font-medium'>口調の例</p>
            <div className='space-y-2'>
              {fields.map((field, idx) => (
                <FormField
                  key={field.id}
                  control={form.control}
                  name={`speech_examples.${idx}.value`}
                  render={({ field: itemField }) => (
                    <FormItem>
                      <div className='flex items-center gap-2'>
                        <FormControl>
                          <Input placeholder={`例 ${idx + 1}: 「俺はそんなこと知らねえ」`} {...itemField} />
                        </FormControl>
                        <Button
                          type='button'
                          variant='ghost'
                          size='icon'
                          aria-label='削除'
                          className='shrink-0 size-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive [&_svg]:size-5!'
                          onClick={() => remove(idx)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ))}
            </div>
            <Button
              type='button'
              variant='outline'
              size='sm'
              className='[&_svg]:size-5!'
              onClick={() => append({ value: '' })}
            >
              <Plus />
              口調の例を追加
            </Button>
          </div>

          <FormField
            control={form.control}
            name='description'
            render={({ field }) => (
              <FormItem className='space-y-2'>
                <FormLabel>説明・背景</FormLabel>
                <FormControl>
                  <Textarea
                    placeholder='例: 孤独な魔法使いの見習い。幼い頃に両親を失い、師匠のもとで修行を積む。'
                    rows={4}
                    className='resize-none'
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* ── バリエーション ── */}
        <div className='space-y-3 border-t pt-5'>
          <div>
            <p className='text-sm font-medium'>バリエーション（任意）</p>
            <p className='mt-0.5 text-sm text-muted-foreground'>
              別の姿・状態をバリエーションとして登録できます。空欄の項目はベースの設定を引き継ぎます。本文生成時にどのバリエーションを使うか選べます。
            </p>
          </div>

          {variantFields.length > 0 && (
            <div className='space-y-3'>
              {variantFields.map((field, idx) => (
                <div key={field.id} className='space-y-2 rounded-md border p-3'>
                  <div className='flex items-center gap-2'>
                    <FormField
                      control={form.control}
                      name={`variants.${idx}.label`}
                      render={({ field: itemField }) => (
                        <FormItem className='flex-1'>
                          <FormControl>
                            <Input placeholder={`バリエーション名 (例: 覚醒後 / 成長後)`} {...itemField} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <Button
                      type='button'
                      variant='ghost'
                      size='icon'
                      aria-label='バリエーションを削除'
                      className='shrink-0 size-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive [&_svg]:size-5!'
                      onClick={() => removeVariant(idx)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  <div className='grid grid-cols-1 gap-2 sm:grid-cols-3'>
                    <FormField
                      control={form.control}
                      name={`variants.${idx}.age`}
                      render={({ field: itemField }) => (
                        <FormItem>
                          <FormControl>
                            <Input placeholder='年齢（継承可）' {...itemField} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name={`variants.${idx}.occupation`}
                      render={({ field: itemField }) => (
                        <FormItem>
                          <Select value={itemField.value} onValueChange={itemField.onChange}>
                            <FormControl>
                              <SelectTrigger className='w-full'>
                                <SelectValue placeholder='職業（ベース継承）' />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {OCCUPATION_OPTIONS.map((o) => (
                                <SelectItem key={o} value={o}>
                                  {o}
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
                      name={`variants.${idx}.first_person`}
                      render={({ field: itemField }) => (
                        <FormItem>
                          <Select value={itemField.value} onValueChange={itemField.onChange}>
                            <FormControl>
                              <SelectTrigger className='w-full'>
                                <SelectValue placeholder='一人称（ベース継承）' />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {FIRST_PERSON_OPTIONS.map((p) => (
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
                  </div>
                  <FormField
                    control={form.control}
                    name={`variants.${idx}.address_others`}
                    render={({ field: itemField }) => (
                      <FormItem>
                        <Select value={itemField.value} onValueChange={itemField.onChange}>
                          <FormControl>
                            <SelectTrigger className='w-full'>
                              <SelectValue placeholder='他者の呼び方（ベース継承）' />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {ADDRESS_STYLES.map((s) => (
                              <SelectItem key={s} value={s}>
                                {s}
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
                    name={`variants.${idx}.appearance`}
                    render={({ field: itemField }) => (
                      <FormItem>
                        <FormControl>
                          <Textarea
                            placeholder='このバリエーションの外見（空欄ならベースのまま）'
                            rows={2}
                            {...itemField}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name={`variants.${idx}.description`}
                    render={({ field: itemField }) => (
                      <FormItem>
                        <FormControl>
                          <Textarea
                            placeholder='このバリエーションの説明・背景（空欄ならベースのまま）'
                            rows={3}
                            {...itemField}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name={`variants.${idx}.speech`}
                    render={({ field: itemField }) => (
                      <FormItem>
                        <FormControl>
                          <Textarea
                            placeholder='このバリエーションの口調の例（1行に1つ。空欄ならベースのまま）'
                            rows={3}
                            {...itemField}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              ))}
            </div>
          )}

          <Button
            type='button'
            variant='outline'
            size='sm'
            className='[&_svg]:size-5!'
            onClick={() =>
              appendVariant({
                label: '',
                age: '',
                occupation: '',
                appearance: '',
                first_person: '',
                address_others: '',
                description: '',
                speech: ''
              })
            }
          >
            <Plus />
            バリエーションを追加
          </Button>
        </div>

        <Button type='submit' disabled={isSubmitting} className='[&_svg]:size-5!'>
          {isSubmitting ? (
            <>
              <Loader2 className='animate-spin' />
              保存中...
            </>
          ) : (
            <>
              <Save />
              {submitLabel}
            </>
          )}
        </Button>
      </form>
    </Form>
  )
}
