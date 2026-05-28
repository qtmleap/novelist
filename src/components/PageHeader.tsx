'use client'

import { Fragment } from 'react'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator
} from '@/components/ui/breadcrumb'

export type Crumb = {
  label: string
  href?: string
}

type Props = {
  crumbs: Crumb[]
}

export function PageHeader({ crumbs }: Props) {
  return (
    <Breadcrumb className='flex min-h-8 items-center'>
      <BreadcrumbList>
        {crumbs.map((c, idx) => {
          const isLast = idx === crumbs.length - 1
          const key = `${c.href ?? ''}|${c.label}`
          return (
            <Fragment key={key}>
              <BreadcrumbItem>
                {isLast || !c.href ? (
                  <BreadcrumbPage className='max-w-[20ch] truncate'>{c.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink href={c.href} className='max-w-[16ch] truncate'>
                    {c.label}
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {!isLast && <BreadcrumbSeparator />}
            </Fragment>
          )
        })}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
