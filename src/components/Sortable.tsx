'use client'

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
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
import type { CSSProperties, ReactNode } from 'react'

type SortableListProps = {
  ids: string[]
  // 並び替え完了時に新しい id 順を返す。
  onReorder: (ids: string[]) => void
  children: ReactNode
}

// 縦リストのドラッグ並び替えコンテナ。ポインタは 4px 動かすまでドラッグ開始しないので
// ハンドル以外のクリック (リンク遷移など) を邪魔しない。キーボード操作にも対応。
export function SortableList({ ids, onReorder, children }: SortableListProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (over === null || active.id === over.id) return
    const oldIndex = ids.indexOf(String(active.id))
    const newIndex = ids.indexOf(String(over.id))
    if (oldIndex === -1 || newIndex === -1) return
    onReorder(arrayMove(ids, oldIndex, newIndex))
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  )
}

export type DragHandleProps = Record<string, unknown>

type SortableItemRender = (args: {
  setNodeRef: (node: HTMLElement | null) => void
  style: CSSProperties
  isDragging: boolean
  // ドラッグハンドルにする要素へ spread する (attributes + listeners)。
  handleProps: DragHandleProps
}) => ReactNode

// 1 行を sortable にする。ハンドルだけをドラッグ起点にしたいので listeners は
// 行全体ではなく handleProps として呼び出し側に渡す。
export function SortableItem({ id, children }: { id: string; children: SortableItemRender }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    zIndex: isDragging ? 10 : undefined
  }
  return children({ setNodeRef, style, isDragging, handleProps: { ...attributes, ...listeners } })
}
