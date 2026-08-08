'use client'

import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useMutation, useQueryClient, useSuspenseQueries } from '@tanstack/react-query'
import { GripVertical, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { NovelSkeleton } from '@/components/novel/NovelSkeleton'
import { PageHeader } from '@/components/PageHeader'
import { QueryBoundary } from '@/components/QueryBoundary'
import { Badge } from '@/components/ui/badge'
import { api, readApiError } from '@/lib/api/client'
import { ageRatingClass } from '@/lib/novel/format'
import { routes } from '@/lib/routes'
import { cn } from '@/lib/utils'
import type { Novel } from '@/schemas/novel.dto'

// 未分類コンテナのキー (category_id は null)。
const NO_CATEGORY = '__uncategorized__'

type Container = { key: string; categoryId: string | null; label: string }

function NovelCardBody({ novel }: { novel: Novel }) {
  return (
    <>
      <span className='min-w-0 flex-1 truncate text-sm font-medium'>{novel.title}</span>
      <Badge variant='outline' className={cn('shrink-0 text-xs', ageRatingClass(novel.age_rating))}>
        {novel.age_rating}
      </Badge>
    </>
  )
}

function SortableNovelCard({ novel }: { novel: Novel }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: novel.id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className='flex items-center gap-2 bg-background px-3 py-2'
    >
      <button
        type='button'
        aria-label='ドラッグして移動'
        className='shrink-0 cursor-grab touch-none text-muted-foreground active:cursor-grabbing [&_svg]:size-5'
        {...attributes}
        {...listeners}
      >
        <GripVertical />
      </button>
      <NovelCardBody novel={novel} />
    </div>
  )
}

function CategoryColumn({
  container,
  ids,
  novelMap
}: {
  container: Container
  ids: string[]
  novelMap: Map<string, Novel>
}) {
  const { setNodeRef, isOver } = useDroppable({ id: container.key })
  return (
    <section>
      <h2 className='mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground'>
        {container.label} <span className='tabular-nums'>({ids.length})</span>
      </h2>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={cn(
            'min-h-12 divide-y rounded-md border transition-colors',
            isOver && 'border-primary bg-primary/5',
            ids.length === 0 && 'flex items-center justify-center'
          )}
        >
          {ids.length === 0 ? (
            <p className='py-3 text-xs text-muted-foreground'>ここにドラッグ</p>
          ) : (
            ids.map((id) => {
              const novel = novelMap.get(id)
              if (novel === undefined) return null
              return <SortableNovelCard key={id} novel={novel} />
            })
          )}
        </div>
      </SortableContext>
    </section>
  )
}

function OrganizeContent() {
  const queryClient = useQueryClient()
  const [{ data: novels }, { data: categories }] = useSuspenseQueries({
    queries: [
      { queryKey: ['novels'], queryFn: () => api.listNovels() },
      { queryKey: ['categories'], queryFn: () => api.listCategories() }
    ]
  })

  const novelMap = new Map(novels.map((n) => [n.id, n]))

  const containers: Container[] = [
    ...categories.map((c) => ({ key: c.id, categoryId: c.id, label: c.name })),
    { key: NO_CATEGORY, categoryId: null, label: '未分類' }
  ]

  // コンテナ (カテゴリ + 未分類) ごとの novel id 配列。novels は position 順なのでそのまま積む。
  const [items, setItems] = useState<Record<string, string[]>>(() => {
    const init: Record<string, string[]> = {}
    for (const c of containers) init[c.key] = []
    for (const n of novels) {
      const key = n.category_id === null ? NO_CATEGORY : n.category_id
      if (init[key] !== undefined) init[key].push(n.id)
      else init[NO_CATEGORY].push(n.id)
    }
    return init
  })
  const [activeId, setActiveId] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const saveMutation = useMutation({
    mutationFn: (next: Record<string, string[]>) =>
      api.arrangeNovels({ groups: containers.map((c) => ({ category_id: c.categoryId, ids: next[c.key] })) }),
    onSuccess: () => {
      // 一覧側のキャッシュを最新化 (グループ・並び順)。
      void queryClient.invalidateQueries({ queryKey: ['novels'] })
      void queryClient.invalidateQueries({ queryKey: ['categories'] })
    },
    onError: (e) => toast.error(readApiError(e, '保存に失敗しました'))
  })

  const findContainer = (id: string): string | undefined => {
    if (items[id] !== undefined) return id
    return Object.keys(items).find((key) => items[key].includes(id))
  }

  const handleDragStart = (event: DragStartEvent) => setActiveId(String(event.active.id))

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event
    if (over === null) return
    const activeContainer = findContainer(String(active.id))
    const overContainer = findContainer(String(over.id))
    if (activeContainer === undefined || overContainer === undefined || activeContainer === overContainer) return
    setItems((prev) => {
      const activeItems = prev[activeContainer]
      const overItems = prev[overContainer]
      const overId = String(over.id)
      // over がコンテナそのものなら末尾、カードならその位置に挿入。
      const overIndex = overItems.indexOf(overId)
      const insertAt = overIndex >= 0 ? overIndex : overItems.length
      return {
        ...prev,
        [activeContainer]: activeItems.filter((id) => id !== String(active.id)),
        [overContainer]: [...overItems.slice(0, insertAt), String(active.id), ...overItems.slice(insertAt)]
      }
    })
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    setActiveId(null)
    if (over === null) return
    const activeContainer = findContainer(String(active.id))
    const overContainer = findContainer(String(over.id))
    if (activeContainer === undefined || overContainer === undefined) return

    let next = items
    if (activeContainer === overContainer) {
      const arr = items[activeContainer]
      const oldIndex = arr.indexOf(String(active.id))
      const overIndex = arr.indexOf(String(over.id))
      const newIndex = overIndex >= 0 ? overIndex : arr.length - 1
      if (oldIndex !== newIndex && oldIndex >= 0) {
        next = { ...items, [activeContainer]: arrayMove(arr, oldIndex, newIndex) }
        setItems(next)
      }
    }
    saveMutation.mutate(next)
  }

  const activeNovel = activeId !== null ? novelMap.get(activeId) : undefined

  return (
    <>
      <div className='flex items-center justify-between gap-3'>
        <div>
          <h1 className='text-xl font-semibold'>小説を整理</h1>
          <p className='mt-0.5 text-sm text-muted-foreground'>
            カードをドラッグしてカテゴリへ移動・並び替えできます。変更は自動保存されます。
          </p>
        </div>
        {saveMutation.isPending && <Loader2 className='size-5 shrink-0 animate-spin text-muted-foreground' />}
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <div className='space-y-6'>
          {containers.map((container) => (
            <CategoryColumn key={container.key} container={container} ids={items[container.key]} novelMap={novelMap} />
          ))}
        </div>
        <DragOverlay>
          {activeNovel !== undefined ? (
            <div className='flex items-center gap-2 rounded-md border bg-background px-3 py-2 shadow-lg'>
              <GripVertical className='size-5 shrink-0 text-muted-foreground' />
              <NovelCardBody novel={activeNovel} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </>
  )
}

export default function NovelOrganizePage() {
  return (
    <div className='space-y-6'>
      <PageHeader crumbs={[{ label: '小説一覧', href: routes.novels.list }, { label: '整理' }]} />
      <QueryBoundary fallback={<NovelSkeleton />}>
        <OrganizeContent />
      </QueryBoundary>
    </div>
  )
}
