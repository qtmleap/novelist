'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2, Save, X } from 'lucide-react'
import { type Resolver, useForm } from 'react-hook-form'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  ADDRESS_STYLES,
  type CharacterVariantInput,
  CharacterVariantInputSchema,
  FIRST_PERSON_OPTIONS,
  OCCUPATION_OPTIONS
} from '@/schemas/character.dto'

// 口調は 1 行 1 例の textarea で持ち、送信時に配列へ分解する。
const VariantFormSchema = CharacterVariantInputSchema.omit({ speech_examples: true }).extend({
  speech: z.string().max(6200).default('')
})
type VariantFormValues = z.infer<typeof VariantFormSchema>

type Props = {
  defaultValues?: CharacterVariantInput
  submitLabel: string
  onSubmit: (data: CharacterVariantInput) => Promise<void>
  onCancel: () => void
  isSubmitting?: boolean
}

export function VariantForm({ defaultValues, submitLabel, onSubmit, onCancel, isSubmitting = false }: Props) {
  const form = useForm<VariantFormValues>({
    resolver: zodResolver(VariantFormSchema) as Resolver<VariantFormValues>,
    defaultValues: {
      label: defaultValues ? defaultValues.label : '',
      age: defaultValues ? defaultValues.age : '',
      occupation: defaultValues ? defaultValues.occupation : '',
      appearance: defaultValues ? defaultValues.appearance : '',
      first_person: defaultValues ? defaultValues.first_person : '',
      address_others: defaultValues ? defaultValues.address_others : '',
      description: defaultValues ? defaultValues.description : '',
      speech: defaultValues ? defaultValues.speech_examples.join('\n') : ''
    },
    mode: 'onSubmit'
  })

  const handleSubmit = form.handleSubmit((data) => {
    const input: CharacterVariantInput = {
      label: data.label.trim(),
      age: data.age,
      occupation: data.occupation,
      appearance: data.appearance,
      first_person: data.first_person,
      address_others: data.address_others,
      description: data.description,
      speech_examples: data.speech
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
    }
    return onSubmit(input)
  })

  return (
    <Form {...form}>
      <form onSubmit={handleSubmit} className='space-y-3'>
        <p className='text-xs text-muted-foreground'>空欄の項目はベース (登場人物本体) の設定を引き継ぎます。</p>

        <FormField
          control={form.control}
          name='label'
          render={({ field }) => (
            <FormItem className='space-y-2'>
              <FormLabel>
                バリエーション名 <span className='text-destructive'>*</span>
              </FormLabel>
              <FormControl>
                <Input placeholder='例: 覚醒後 / 制服 / 老年期' {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className='grid grid-cols-1 gap-3 sm:grid-cols-3'>
          <FormField
            control={form.control}
            name='age'
            render={({ field }) => (
              <FormItem className='space-y-2'>
                <FormLabel>年齢</FormLabel>
                <FormControl>
                  <Input placeholder='継承可' {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name='occupation'
            render={({ field }) => (
              <FormItem className='space-y-2'>
                <FormLabel>職業</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger className='w-full'>
                      <SelectValue placeholder='ベース継承' />
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
                      <SelectValue placeholder='ベース継承' />
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
          name='address_others'
          render={({ field }) => (
            <FormItem className='space-y-2'>
              <FormLabel>他者の呼び方</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger className='w-full sm:w-52'>
                    <SelectValue placeholder='ベース継承' />
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
          name='appearance'
          render={({ field }) => (
            <FormItem className='space-y-2'>
              <FormLabel>外見</FormLabel>
              <FormControl>
                <Textarea placeholder='この姿の外見（空欄ならベースのまま）' rows={2} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name='speech'
          render={({ field }) => (
            <FormItem className='space-y-2'>
              <FormLabel>口調の例</FormLabel>
              <FormControl>
                <Textarea placeholder='1行に1つ（空欄ならベースのまま）' rows={3} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name='description'
          render={({ field }) => (
            <FormItem className='space-y-2'>
              <FormLabel>説明・背景</FormLabel>
              <FormControl>
                <Textarea placeholder='この姿の説明・背景（空欄ならベースのまま）' rows={3} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className='flex items-center gap-2'>
          <Button type='submit' size='sm' disabled={isSubmitting} className='[&_svg]:size-5!'>
            {isSubmitting ? <Loader2 className='animate-spin' /> : <Save />}
            {submitLabel}
          </Button>
          <Button type='button' size='sm' variant='ghost' onClick={onCancel} className='[&_svg]:size-5!'>
            <X />
            キャンセル
          </Button>
        </div>
      </form>
    </Form>
  )
}
