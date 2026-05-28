'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2, Plus, Save, Trash2 } from 'lucide-react'
import { type Resolver, useFieldArray, useForm } from 'react-hook-form'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
  defaultValues?: Partial<CreateCharacterInput>
  submitLabel: string
  onSubmit: (data: CreateCharacterInput) => Promise<void>
  isSubmitting?: boolean
}

// useFieldArray は文字列配列を直接扱えないので、フォーム内では { value: string } の行として保持し
// onSubmit 時に string[] にフラット化する。リゾルバ用スキーマもそのフォーム形に合わせる必要がある
// (CreateCharacterSchema をそのまま使うと speech_examples で型不一致になり handleSubmit が無音で失敗する)。
const FormSchema = CreateCharacterSchema.extend({
  speech_examples: z
    .array(z.object({ value: z.string().max(300) }))
    .max(20)
    .default([])
})
type FormValues = z.infer<typeof FormSchema>

export function CharacterForm({ defaultValues, submitLabel, onSubmit, isSubmitting = false }: Props) {
  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema) as unknown as Resolver<FormValues>,
    defaultValues: {
      name: '',
      gender: '',
      age: '',
      occupation: '',
      appearance: '',
      first_person: '',
      address_others: '',
      speech_examples: (defaultValues?.speech_examples ?? []).map((v) => ({ value: v })),
      description: '',
      ...Object.fromEntries(Object.entries(defaultValues ?? {}).filter(([k]) => k !== 'speech_examples'))
    },
    mode: 'onSubmit'
  })

  const { fields, append, remove } = useFieldArray<FormValues, 'speech_examples'>({
    control: form.control,
    name: 'speech_examples'
  })

  const gender = form.watch('gender')
  const firstPerson = form.watch('first_person')
  const occupation = form.watch('occupation')

  const handleSubmit = form.handleSubmit((data) => {
    const flattened: CreateCharacterInput = {
      ...data,
      speech_examples: data.speech_examples.map((r) => r.value).filter((v) => v.trim() !== '')
    }
    return onSubmit(flattened)
  })

  return (
    <form onSubmit={handleSubmit} className='space-y-5'>
      <div className='space-y-4'>
        <div className='grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_10rem_8rem]'>
          <div className='space-y-2'>
            <Label htmlFor='name'>
              名前 <span className='text-destructive'>*</span>
            </Label>
            <Input id='name' placeholder='例: ルカ' {...form.register('name')} />
            {form.formState.errors.name && (
              <p className='text-xs text-destructive'>{form.formState.errors.name.message}</p>
            )}
          </div>

          <div className='space-y-2'>
            <Label htmlFor='gender'>性別</Label>
            <Select value={gender} onValueChange={(v) => form.setValue('gender', v, { shouldValidate: false })}>
              <SelectTrigger id='gender' className='w-full'>
                <SelectValue placeholder='選択（任意）' />
              </SelectTrigger>
              <SelectContent>
                {GENDER_OPTIONS.map((g) => (
                  <SelectItem key={g} value={g}>
                    {g}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.formState.errors.gender && (
              <p className='text-xs text-destructive'>{form.formState.errors.gender.message}</p>
            )}
          </div>

          <div className='space-y-2'>
            <Label htmlFor='age'>年齢</Label>
            <Input id='age' placeholder='例: 17歳' {...form.register('age')} />
            {form.formState.errors.age && (
              <p className='text-xs text-destructive'>{form.formState.errors.age.message}</p>
            )}
          </div>
        </div>

        <div className='space-y-2'>
          <Label htmlFor='appearance'>外見</Label>
          <Textarea
            id='appearance'
            placeholder='例: 銀色の長髪、青い瞳、細身の体格'
            rows={3}
            {...form.register('appearance')}
            className='resize-none'
          />
          {form.formState.errors.appearance && (
            <p className='text-xs text-destructive'>{form.formState.errors.appearance.message}</p>
          )}
        </div>

        <div className='grid grid-cols-1 gap-4 sm:grid-cols-3'>
          <div className='space-y-2'>
            <Label htmlFor='occupation'>職業</Label>
            <Select value={occupation} onValueChange={(v) => form.setValue('occupation', v, { shouldValidate: false })}>
              <SelectTrigger id='occupation' className='w-full'>
                <SelectValue placeholder='選択（任意）' />
              </SelectTrigger>
              <SelectContent>
                {OCCUPATION_OPTIONS.map((o) => (
                  <SelectItem key={o} value={o}>
                    {o}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.formState.errors.occupation && (
              <p className='text-xs text-destructive'>{form.formState.errors.occupation.message}</p>
            )}
          </div>

          <div className='space-y-2'>
            <Label htmlFor='first_person'>一人称</Label>
            <Select
              value={firstPerson}
              onValueChange={(v) => form.setValue('first_person', v, { shouldValidate: false })}
            >
              <SelectTrigger id='first_person' className='w-full'>
                <SelectValue placeholder='選択（任意）' />
              </SelectTrigger>
              <SelectContent>
                {FIRST_PERSON_OPTIONS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.formState.errors.first_person && (
              <p className='text-xs text-destructive'>{form.formState.errors.first_person.message}</p>
            )}
          </div>

          <div className='space-y-2'>
            <Label htmlFor='address_others'>他の人への呼び方</Label>
            <Select
              value={form.watch('address_others')}
              onValueChange={(v) => form.setValue('address_others', v, { shouldValidate: false })}
            >
              <SelectTrigger id='address_others' className='w-full'>
                <SelectValue placeholder='呼び方を選択（任意）' />
              </SelectTrigger>
              <SelectContent>
                {ADDRESS_STYLES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.formState.errors.address_others && (
              <p className='text-xs text-destructive'>{form.formState.errors.address_others.message}</p>
            )}
          </div>
        </div>

        <div className='space-y-2'>
          <Label>口調の例</Label>
          <div className='space-y-2'>
            {fields.map((field, idx) => (
              <div key={field.id} className='flex items-center gap-2'>
                <Input
                  placeholder={`例 ${idx + 1}: 「俺はそんなこと知らねえ」`}
                  {...form.register(`speech_examples.${idx}.value`)}
                />
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

        <div className='space-y-2'>
          <Label htmlFor='description'>説明・背景</Label>
          <Textarea
            id='description'
            placeholder='例: 孤独な魔法使いの見習い。幼い頃に両親を失い、師匠のもとで修行を積む。'
            rows={4}
            {...form.register('description')}
            className='resize-none'
          />
          {form.formState.errors.description && (
            <p className='text-xs text-destructive'>{form.formState.errors.description.message}</p>
          )}
        </div>
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
  )
}
