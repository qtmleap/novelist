'use client'

import { BaseEdge, type Edge, EdgeLabelRenderer, type EdgeProps, getBezierPath } from '@xyflow/react'
import { cn } from '@/lib/utils'

// 片方向ぶんの関係 (= ある人から見た相手の立場 + 相手の呼び方)。
export type DirRelation = {
  relation: string
  address_override: string
}

// エッジ = 2 人の間の 1 本の関係。方向ごとに立場を別々に持つ:
//   forward: source→target。「target は source にとって何か」(= target 側のラベル)。
//   reverse: target→source。「source は target にとって何か」(= source 側のラベル)。
// 例) source=A, target=B で「B は A の先輩 / A は B の後輩」なら forward.relation='先輩', reverse.relation='後輩'。
// 両側あり = 相互 (実線)、片側だけ = 一方向 (点線・矢印)。保存時は埋まっている向きだけ行にする。
export type RelationEdgeData = {
  forward: DirRelation
  reverse: DirRelation
  description: string
}
export type RelationFlowEdge = Edge<RelationEdgeData, 'relation'>

function LabelPill({
  x,
  y,
  text,
  selected,
  muted
}: {
  x: number
  y: number
  text: string
  selected: boolean
  muted?: boolean
}) {
  return (
    <div
      className={cn(
        'pointer-events-none absolute rounded-full border px-2 py-0.5 text-xs font-medium shadow-sm',
        selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background',
        muted && !selected && 'text-muted-foreground'
      )}
      style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
    >
      {text}
    </div>
  )
}

export function RelationEdgeLine({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerStart,
  markerEnd,
  data,
  selected
}: EdgeProps<RelationFlowEdge>) {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  const isSelected = selected === true

  const fwd = data !== undefined ? data.forward.relation : ''
  const rev = data !== undefined ? data.reverse.relation : ''
  const fwdFilled = fwd !== ''
  const revFilled = rev !== ''
  const both = fwdFilled && revFilled
  const oneSided = !both && (fwdFilled || revFilled)
  const none = !fwdFilled && !revFilled

  // 一方向は埋まっている側に向けて矢印。forward は target を説明するので矢印は target 端 (markerEnd)。
  const showEndArrow = oneSided && fwdFilled
  const showStartArrow = oneSided && revFilled

  // ラベルは線の中央やや上に 1 つ。非対称 (forward ≠ reverse) は「XX/YY」表示、対称は 1 語、片方向はその語。
  const centerX = (sourceX + targetX) / 2
  const centerY = (sourceY + targetY) / 2 - 12
  const labelText = none ? '未設定' : both ? (fwd === rev ? fwd : `${fwd}/${rev}`) : fwdFilled ? fwd : rev

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerStart={showStartArrow ? markerStart : undefined}
        markerEnd={showEndArrow ? markerEnd : undefined}
        style={{ strokeWidth: isSelected ? 2 : 1.5, strokeDasharray: oneSided ? '6 4' : undefined }}
      />
      <EdgeLabelRenderer>
        <LabelPill x={centerX} y={centerY} text={labelText} selected={isSelected} muted={none} />
      </EdgeLabelRenderer>
    </>
  )
}
