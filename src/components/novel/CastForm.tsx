'use client'

import '@xyflow/react/dist/style.css'

import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import {
  Background,
  type Connection,
  ConnectionMode,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState
} from '@xyflow/react'
import { Copy, Loader2, Save, Trash2, UserPlus } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AddressSuggestions } from '@/components/AddressSuggestions'
import { MultiSelect } from '@/components/MultiSelect'
import { CastGraphContext, type CharacterFlowNode, CharacterNode } from '@/components/novel/CharacterNode'
import {
  type DirRelation,
  type RelationEdgeData,
  RelationEdgeLine,
  type RelationFlowEdge
} from '@/components/novel/RelationEdgeLine'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api/client'
import { routes } from '@/lib/routes'
import type { Character } from '@/schemas/character.dto'
import { FOCAL_POVS, RELATION_SEPARATOR, RELATION_TYPES, type SaveCastInput, SaveCastSchema } from '@/schemas/novel.dto'

type Props = {
  // 取り込み元の一覧から自分自身を除くのに使う。
  novelId: string
  // 小説の視点 (語り手を選べる POV か判定するのに使う)。
  pov: string
  defaultValues: SaveCastInput
  onSubmit: (data: SaveCastInput) => Promise<void>
  isSubmitting?: boolean
}

const pairKey = (a: string, b: string) => [a, b].slice().sort().join('|')

const emptyDir = (): DirRelation => ({ relation: '', address_override: '' })
const emptyRelationData = (): RelationEdgeData => ({ forward: emptyDir(), reverse: emptyDir(), description: '' })

// 両端ぶんの矢印マーカーを定義しておく (実際にどちらを出すかは RelationEdgeLine が向きで決める)。
const ARROW = { type: MarkerType.ArrowClosed }

// 座標は永続化しないので、開くたびにキャラ数の正 N 角形 (円周上に等間隔) に自動配置する。
function polygonLayout(count: number, index: number) {
  if (count <= 1) return { x: 0, y: 0 }
  const radius = 150 + count * 20
  const angle = (2 * Math.PI * index) / count
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}

function buildInitialNodes(links: SaveCastInput['character_links'], dictionary: Character[]): CharacterFlowNode[] {
  const total = links.length
  return links.map((link, i) => {
    const char = dictionary.find((c) => c.id === link.character_id)
    return {
      id: link.character_id,
      type: 'character',
      position: polygonLayout(total, i),
      data: {
        characterId: link.character_id,
        name: char !== undefined ? char.name : '(不明な人物)',
        role: link.role,
        variantId: link.variant_id
      }
    }
  })
}

// 保存は有向 (A→B) の行。ノード対ごとに 1 本のエッジへまとめ、方向ごとに立場 (forward/reverse) を持たせる。
// A→B と B→A の両方があれば双方向 (実線)、片側だけなら一方向 (点線・矢印)。
function buildInitialEdges(relations: SaveCastInput['relations']): RelationFlowEdge[] {
  type Group = { source: string; target: string; forward: DirRelation; reverse: DirRelation; description: string }
  const groups = new Map<string, Group>()
  for (const r of relations) {
    const key = [r.source_character_id, r.target_character_id].slice().sort().join('|')
    let g = groups.get(key)
    if (g === undefined) {
      // 最初に出てきた行の向きを正方向 (source→target) として固定する。
      g = {
        source: r.source_character_id,
        target: r.target_character_id,
        forward: emptyDir(),
        reverse: emptyDir(),
        description: ''
      }
      groups.set(key, g)
    }
    const dir: DirRelation = { relation: r.relation, address_override: r.address_override }
    if (r.source_character_id === g.source && r.target_character_id === g.target) g.forward = dir
    else g.reverse = dir
    if (g.description === '' && r.description !== '') g.description = r.description
  }
  let i = 0
  const edges: RelationFlowEdge[] = []
  for (const g of groups.values()) {
    edges.push({
      id: `rel-${i++}`,
      type: 'relation',
      source: g.source,
      target: g.target,
      markerStart: ARROW,
      markerEnd: ARROW,
      data: { forward: g.forward, reverse: g.reverse, description: g.description }
    })
  }
  return edges
}

export function CastForm({ novelId, pov, defaultValues, onSubmit, isSubmitting = false }: Props) {
  const queryClient = useQueryClient()
  const { data: dictionary } = useSuspenseQuery({
    queryKey: ['characters'],
    queryFn: () => api.listCharacters()
  })
  const { data: novelList } = useSuspenseQuery({
    queryKey: ['novels'],
    queryFn: () => api.listNovels()
  })
  const [importOpen, setImportOpen] = useState(false)
  const [importing, setImporting] = useState(false)

  const canChooseNarrator = FOCAL_POVS.includes(pov)

  const [nodes, setNodes, onNodesChange] = useNodesState<CharacterFlowNode>(
    buildInitialNodes(defaultValues.character_links, dictionary)
  )
  const [edges, setEdges, onEdgesChange] = useEdgesState<RelationFlowEdge>(buildInitialEdges(defaultValues.relations))
  const [narratorId, setNarratorId] = useState(defaultValues.pov_character_id)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  // ノードを選ぶと、そのキャラが関わる関係をサイドバーに一覧表示する。
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

  const edgeSeq = useRef(0)

  const nodeTypes = useMemo(() => ({ character: CharacterNode }), [])
  const edgeTypes = useMemo(() => ({ relation: RelationEdgeLine }), [])

  // 辞典の variants を characterId で引けるようにしておく (ノードのバリエーション選択に使う)。
  const variantsByCharacter = useMemo(() => {
    const map = new Map<string, Character['variants']>()
    for (const c of dictionary) map.set(c.id, c.variants)
    return map
  }, [dictionary])
  const variantsOf = useCallback(
    (characterId: string) => {
      const v = variantsByCharacter.get(characterId)
      return v !== undefined ? v : []
    },
    [variantsByCharacter]
  )

  const handleRoleChange = useCallback(
    (characterId: string, role: string) => {
      setNodes((nds) => nds.map((n) => (n.id === characterId ? { ...n, data: { ...n.data, role } } : n)))
    },
    [setNodes]
  )

  const handleVariantChange = useCallback(
    (characterId: string, variantId: string | null) => {
      setNodes((nds) => nds.map((n) => (n.id === characterId ? { ...n, data: { ...n.data, variantId } } : n)))
    },
    [setNodes]
  )

  const handleToggleNarrator = useCallback((characterId: string) => {
    setNarratorId((prev) => (prev === characterId ? '' : characterId))
  }, [])

  const handleDeleteCharacter = useCallback(
    (characterId: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== characterId))
      setEdges((eds) => eds.filter((e) => e.source !== characterId && e.target !== characterId))
      setNarratorId((prev) => (prev === characterId ? '' : prev))
      setSelectedNodeId((prev) => (prev === characterId ? null : prev))
    },
    [setNodes, setEdges]
  )

  const handleAddCharacter = useCallback(
    (char: Character) => {
      setNodes((nds) => {
        if (nds.some((n) => n.id === char.id)) return nds
        const node: CharacterFlowNode = {
          id: char.id,
          type: 'character',
          position: polygonLayout(nds.length + 1, nds.length),
          data: { characterId: char.id, name: char.name, role: '', variantId: null }
        }
        return [...nds, node]
      })
    },
    [setNodes]
  )

  // 他の小説の登場人物・関係を現在の編集内容に追加で取り込む (既存の関係はそのまま)。
  const handleImport = useCallback(
    async (sourceId: string) => {
      setImporting(true)
      try {
        const source = await queryClient.fetchQuery({
          queryKey: ['novel', sourceId],
          queryFn: () => api.getNovel({ params: { id: sourceId } })
        })
        // 不足している登場人物をノード追加し、全体を正 N 角形に再配置する。
        const haveIds = new Set(nodes.map((n) => n.id))
        const addedNodes: CharacterFlowNode[] = source.cast
          .filter((c) => !haveIds.has(c.character_id))
          .map((c) => ({
            id: c.character_id,
            type: 'character',
            position: { x: 0, y: 0 },
            data: { characterId: c.character_id, name: c.name, role: c.role, variantId: c.variant_id }
          }))
        const mergedNodes = [...nodes, ...addedNodes].map((n, i, arr) => ({
          ...n,
          position: polygonLayout(arr.length, i)
        }))
        // 既にエッジがあるペアは現状維持。無いペアだけ取り込む。
        const existingPairs = new Set(edges.map((e) => pairKey(e.source, e.target)))
        const importedRows = source.relations
          .filter((r) => !existingPairs.has(pairKey(r.source_character_id, r.target_character_id)))
          .map((r) => ({
            source_character_id: r.source_character_id,
            target_character_id: r.target_character_id,
            relation: r.relation,
            description: r.description,
            address_override: r.address_override
          }))
        const importedEdges = buildInitialEdges(importedRows).map((e) => ({
          ...e,
          id: `rel-import-${edgeSeq.current++}`
        }))
        setNodes(mergedNodes)
        setEdges((prev) => [...prev, ...importedEdges])
        toast.success(
          `${source.title} から取り込みました（人物 +${addedNodes.length} / 関係 +${importedEdges.length}）`
        )
        setImportOpen(false)
      } catch {
        toast.error('取り込みに失敗しました')
      } finally {
        setImporting(false)
      }
    },
    [queryClient, nodes, edges, setNodes, setEdges]
  )

  // 同じ 2 人の間に既に線があれば二重に作らず、それを選択する (IN/OUT で線が増えないように)。
  const onConnect = useCallback(
    (conn: Connection) => {
      if (conn.source === conn.target) return
      const existing = edges.find(
        (e) =>
          (e.source === conn.source && e.target === conn.target) ||
          (e.source === conn.target && e.target === conn.source)
      )
      if (existing !== undefined) {
        setSelectedEdgeId(existing.id)
        setSelectedNodeId(null)
        return
      }
      const id = `rel-new-${edgeSeq.current}`
      edgeSeq.current += 1
      const edge: RelationFlowEdge = {
        id,
        type: 'relation',
        source: conn.source,
        target: conn.target,
        markerStart: ARROW,
        markerEnd: ARROW,
        data: emptyRelationData()
      }
      setEdges((eds) => [...eds, edge])
      setSelectedEdgeId(id)
      setSelectedNodeId(null)
    },
    [setEdges, edges]
  )

  const patchSide = useCallback(
    (side: 'forward' | 'reverse', patch: Partial<DirRelation>) => {
      setEdges((eds) =>
        eds.map((e) => {
          if (e.id !== selectedEdgeId) return e
          const data = e.data !== undefined ? e.data : emptyRelationData()
          return { ...e, data: { ...data, [side]: { ...data[side], ...patch } } }
        })
      )
    },
    [setEdges, selectedEdgeId]
  )

  const patchDescription = useCallback(
    (description: string) => {
      setEdges((eds) =>
        eds.map((e) => {
          if (e.id !== selectedEdgeId) return e
          const data = e.data !== undefined ? e.data : emptyRelationData()
          return { ...e, data: { ...data, description } }
        })
      )
    },
    [setEdges, selectedEdgeId]
  )

  const deleteSelectedEdge = useCallback(() => {
    setEdges((eds) => eds.filter((e) => e.id !== selectedEdgeId))
    setSelectedEdgeId(null)
  }, [setEdges, selectedEdgeId])

  // 関係は複数種別の組み合わせ。RELATION_TYPES の並び順を保ったまま '・' で連結して保存する。
  const toggleRelationTag = useCallback(
    (side: 'forward' | 'reverse', current: string, tag: string) => {
      const active = new Set(current === '' ? [] : current.split(RELATION_SEPARATOR))
      if (active.has(tag)) active.delete(tag)
      else active.add(tag)
      patchSide(side, { relation: RELATION_TYPES.filter((t) => active.has(t)).join(RELATION_SEPARATOR) })
    },
    [patchSide]
  )

  const usedIds = new Set(nodes.map((n) => n.id))
  const available = dictionary.filter((c) => !usedIds.has(c.id))
  const otherNovels = novelList.filter((n) => n.id !== novelId)
  const selectedEdge = selectedEdgeId === null ? undefined : edges.find((e) => e.id === selectedEdgeId)
  const selectedData =
    selectedEdge !== undefined && selectedEdge.data !== undefined ? selectedEdge.data : emptyRelationData()
  const nameOf = (id: string) => {
    const n = nodes.find((x) => x.id === id)
    return n !== undefined ? n.data.name : '(不明な人物)'
  }
  const selectedNode = selectedNodeId === null ? undefined : nodes.find((n) => n.id === selectedNodeId)

  // 選択ノードが関わる関係を相手キャラごとに、相手名の昇順で並べる。
  // selfToOther = 自分→相手, otherToSelf = 相手→自分 の種別。
  const nodeRelations = (() => {
    if (selectedNodeId === null) return []
    return edges
      .filter((e) => e.source === selectedNodeId || e.target === selectedNodeId)
      .map((e) => {
        const d = e.data !== undefined ? e.data : emptyRelationData()
        const isSource = e.source === selectedNodeId
        const otherId = isSource ? e.target : e.source
        const selfToOther = isSource ? d.forward.relation : d.reverse.relation
        const otherToSelf = isSource ? d.reverse.relation : d.forward.relation
        return { edge: e, otherName: nameOf(otherId), selfToOther, otherToSelf }
      })
      .sort((a, b) => a.otherName.localeCompare(b.otherName, 'ja'))
  })()

  const handleSave = useCallback(async () => {
    const character_links = nodes.map((n) => ({
      character_id: n.data.characterId,
      role: n.data.role,
      variant_id: n.data.variantId
    }))

    // どちらの向きにも種別が無いエッジは不完全。保存前に知らせて中断する。
    const hasEmpty = edges.some((e) => {
      const d = e.data !== undefined ? e.data : emptyRelationData()
      return d.forward.relation === '' && d.reverse.relation === ''
    })
    if (hasEmpty) {
      toast.error('種別が未設定の関係があります。線を選んで設定してください')
      return
    }

    // 埋まっている向きだけ有向の行にする (双方向は 2 行、一方向は 1 行)。
    const relations: SaveCastInput['relations'] = []
    for (const e of edges) {
      const d = e.data !== undefined ? e.data : emptyRelationData()
      if (d.forward.relation !== '') {
        relations.push({
          source_character_id: e.source,
          target_character_id: e.target,
          relation: d.forward.relation,
          description: d.description,
          address_override: d.forward.address_override
        })
      }
      if (d.reverse.relation !== '') {
        relations.push({
          source_character_id: e.target,
          target_character_id: e.source,
          relation: d.reverse.relation,
          description: d.description,
          address_override: d.reverse.address_override
        })
      }
    }

    const parsed = SaveCastSchema.safeParse({
      pov_character_id: canChooseNarrator ? narratorId : '',
      character_links,
      relations
    })
    if (!parsed.success) {
      toast.error('入力に誤りがあります')
      return
    }
    await onSubmit(parsed.data)
  }, [nodes, edges, narratorId, canChooseNarrator, onSubmit])

  if (dictionary.length === 0) {
    return (
      <p className='text-sm text-muted-foreground'>
        登場人物がまだ登録されていません。{' '}
        <a href={routes.characters.new} className='underline underline-offset-2'>
          辞典に追加する
        </a>
      </p>
    )
  }

  // 1 方向ぶんの編集 UI。fromName → toName の関係 (種別 + from が to を呼ぶ呼び方) を設定する。
  const renderSide = (side: 'forward' | 'reverse', fromName: string, toName: string) => {
    const value = selectedData[side]
    return (
      <div className='space-y-1.5'>
        <p className='text-xs font-medium text-foreground'>
          {fromName} → {toName}
        </p>
        <MultiSelect
          options={RELATION_TYPES}
          selected={value.relation === '' ? [] : value.relation.split(RELATION_SEPARATOR)}
          onToggle={(t) => toggleRelationTag(side, value.relation, t)}
          placeholder='種別を選択'
          className='bg-background'
        />
        <Input
          className='bg-background'
          maxLength={20}
          placeholder='呼び方（任意）'
          value={value.address_override}
          onChange={(e) => patchSide(side, { address_override: e.target.value })}
        />
        <AddressSuggestions value={value.address_override} onPick={(v) => patchSide(side, { address_override: v })} />
      </div>
    )
  }

  return (
    <CastGraphContext.Provider
      value={{
        narratorId,
        canChooseNarrator,
        variantsOf,
        onRoleChange: handleRoleChange,
        onVariantChange: handleVariantChange,
        onToggleNarrator: handleToggleNarrator,
        onDelete: handleDeleteCharacter
      }}
    >
      <div className='space-y-3'>
        {/* ── ツールバー ── */}
        <div className='flex flex-wrap items-center justify-between gap-3'>
          <div className='flex items-center gap-3 text-sm text-muted-foreground'>
            <span>
              登場人物 <span className='font-semibold text-foreground'>{nodes.length}</span>
            </span>
            <span className='text-border'>/</span>
            <span>
              関係 <span className='font-semibold text-foreground'>{edges.length}</span>
            </span>
          </div>
          <Button type='button' size='sm' disabled={isSubmitting} className='[&_svg]:size-5!' onClick={handleSave}>
            {isSubmitting ? <Loader2 className='animate-spin' /> : <Save />}
            保存する
          </Button>
        </div>

        <div className='flex flex-col gap-4 lg:flex-row'>
          {/* ── サイドバー ── */}
          <aside className='flex w-full shrink-0 flex-col overflow-hidden rounded-lg border lg:w-72'>
            <div className='space-y-1.5 border-b p-3'>
              <Popover open={importOpen} onOpenChange={setImportOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    className='w-full justify-start [&_svg]:size-4!'
                    disabled={importing}
                  >
                    {importing ? <Loader2 className='animate-spin' /> : <Copy />}
                    他の小説から取り込む
                  </Button>
                </PopoverTrigger>
                <PopoverContent align='start' className='w-[var(--radix-popover-trigger-width)] p-1'>
                  {otherNovels.length === 0 ? (
                    <p className='px-2 py-1.5 text-xs text-muted-foreground'>取り込める小説がありません。</p>
                  ) : (
                    <div className='max-h-72 overflow-auto'>
                      {otherNovels.map((n) => (
                        <button
                          key={n.id}
                          type='button'
                          onClick={() => handleImport(n.id)}
                          className='block w-full truncate rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent'
                        >
                          {n.title}
                        </button>
                      ))}
                    </div>
                  )}
                </PopoverContent>
              </Popover>
              <p className='text-[11px] text-muted-foreground'>
                選んだ小説の登場人物と関係を、いまの編集内容に追加します（既存の関係はそのまま）。
              </p>
            </div>
            <div className='space-y-2 p-3'>
              <h2 className='text-sm font-semibold'>登場人物を追加</h2>
              <p className='text-xs text-muted-foreground'>
                辞典から選んでキャンバスに置きます。ノード右の○から相手の○へドラッグで関係を作成（既定は双方向）。
              </p>
              {available.length === 0 ? (
                <p className='text-xs text-muted-foreground'>追加できる人物がありません。</p>
              ) : (
                <div className='flex flex-wrap gap-1.5'>
                  {available.map((c) => (
                    <Button
                      key={c.id}
                      type='button'
                      variant='outline'
                      size='sm'
                      className='[&_svg]:size-4!'
                      onClick={() => handleAddCharacter(c)}
                    >
                      <UserPlus />
                      {c.name}
                    </Button>
                  ))}
                </div>
              )}
            </div>

            {selectedEdge !== undefined ? (
              <div className='space-y-3 border-t bg-muted/30 p-3'>
                <h2 className='text-sm font-semibold'>
                  {nameOf(selectedEdge.source)} と {nameOf(selectedEdge.target)} の関係
                </h2>
                {renderSide('forward', nameOf(selectedEdge.source), nameOf(selectedEdge.target))}
                <div className='border-t' />
                {renderSide('reverse', nameOf(selectedEdge.target), nameOf(selectedEdge.source))}
                <Input
                  className='bg-background'
                  placeholder='説明（任意）'
                  value={selectedData.description}
                  onChange={(e) => patchDescription(e.target.value)}
                />
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  className='text-muted-foreground hover:bg-destructive/10 hover:text-destructive [&_svg]:size-4!'
                  onClick={deleteSelectedEdge}
                >
                  <Trash2 />
                  この関係を削除
                </Button>
              </div>
            ) : selectedNode !== undefined ? (
              <div className='space-y-3 border-t bg-muted/30 p-3'>
                <div>
                  <h2 className='text-sm font-semibold'>{selectedNode.data.name} の関係</h2>
                  <p className='mt-0.5 text-xs text-muted-foreground'>
                    {nodeRelations.length > 0
                      ? '関係をクリックすると編集できます。'
                      : 'この人物が関わる関係はまだありません。'}
                  </p>
                </div>
                {nodeRelations.length > 0 && (
                  <ul className='divide-y overflow-hidden rounded-md border bg-background'>
                    {nodeRelations.map(({ edge: e, otherName, selfToOther, otherToSelf }) => {
                      const selfName = selectedNode.data.name
                      const none = selfToOther === '' && otherToSelf === ''
                      return (
                        <li key={e.id}>
                          <button
                            type='button'
                            onClick={() => {
                              setSelectedEdgeId(e.id)
                              setSelectedNodeId(null)
                            }}
                            className='block w-full px-2.5 py-2 text-left text-xs hover:bg-accent'
                          >
                            <div className='truncate font-medium text-foreground'>{otherName}</div>
                            <div className='mt-0.5 space-y-0.5 text-muted-foreground'>
                              {selfToOther !== '' && (
                                <div className='truncate'>
                                  {selfName} → {otherName}：{selfToOther}
                                </div>
                              )}
                              {otherToSelf !== '' && (
                                <div className='truncate'>
                                  {otherName} → {selfName}：{otherToSelf}
                                </div>
                              )}
                              {none && <div>未設定</div>}
                            </div>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            ) : (
              <p className='border-t p-3 text-xs text-muted-foreground'>
                ノードをクリックするとその人物の関係一覧、関係の線をクリックすると編集ができます。
                {canChooseNarrator && ' ノードの★で語り手を指定できます。'}
              </p>
            )}
          </aside>

          {/* ── キャンバス ── */}
          <div className='h-[calc(100vh-15rem)] min-h-[480px] flex-1 overflow-hidden rounded-lg border'>
            <ReactFlow<CharacterFlowNode, RelationFlowEdge>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              connectionMode={ConnectionMode.Loose}
              connectionRadius={130}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={(_, node) => {
                setSelectedNodeId(node.id)
                setSelectedEdgeId(null)
              }}
              onEdgeClick={(_, edge) => {
                setSelectedEdgeId(edge.id)
                setSelectedNodeId(null)
              }}
              onPaneClick={() => {
                setSelectedEdgeId(null)
                setSelectedNodeId(null)
              }}
              fitView
              fitViewOptions={{ padding: 0.3 }}
              className='bg-muted/30'
            >
              <Background gap={16} />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable className='!bg-background' />
            </ReactFlow>
          </div>
        </div>
      </div>
    </CastGraphContext.Provider>
  )
}
