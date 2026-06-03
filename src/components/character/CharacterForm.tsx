'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2, Plus, Save, Trash2 } from 'lucide-react'
import { type DefaultValues, type Resolver, useFieldArray, useForm } from 'react-hook-form'
import { z } from 'zod'
import { AddressSuggestions } from '@/components/AddressSuggestions'
import { Button } from '@/components/ui/button'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
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
    .default([])
})
type FormValues = z.infer<typeof FormSchema>

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
      ...Object.fromEntries(Object.entries(defaultValues ? defaultValues : {}).filter(([k]) => k !== 'speech_examples'))
    },
    mode: 'onSubmit'
  })

  const { fields, append, remove } = useFieldArray<FormValues, 'speech_examples'>({
    control: form.control,
    name: 'speech_examples'
  })

  const handleSubmit = form.handleSubmit((data) => {
    const flattened: CreateCharacterInput = {
      ...data,
      speech_examples: data.speech_examples.map((r) => r.value).filter((v) => v.trim() !== '')
    }
    return onSubmit(flattened)
  })

  return (
    <Form {...form}>
      <form onSubmit={handleSubmit} className='space-y-5'>
        <div className='space-y-4'>
          <div className='grid grid-cols-1 items-start gap-4 sm:grid-cols-[minmax(0,1fr)_10rem_8rem]'>
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

          <div className='grid grid-cols-1 items-start gap-4 sm:grid-cols-3'>
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
                  <FormControl>
                    <Input maxLength={500} placeholder='呼び方（自由入力可・任意）' {...field} />
                  </FormControl>
                  <AddressSuggestions value={field.value} onPick={field.onChange} />
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
