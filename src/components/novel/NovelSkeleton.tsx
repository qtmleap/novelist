import { Skeleton } from '@/components/ui/skeleton'

export function NovelSkeletonRow() {
  return (
    <div className='flex items-center gap-3 px-4 py-3'>
      <Skeleton className='size-5 shrink-0 rounded' />
      <div className='flex-1 space-y-1.5'>
        <Skeleton className='h-4 w-2/5' />
        <Skeleton className='h-3 w-1/3' />
      </div>
      <Skeleton className='ml-auto h-5 w-14 rounded' />
    </div>
  )
}

export function NovelSkeletonList() {
  return (
    <div className='divide-y border-y'>
      {[0, 1, 2].map((i) => (
        <NovelSkeletonRow key={i} />
      ))}
    </div>
  )
}

export function NovelSkeleton() {
  return <NovelSkeletonRow />
}
