# DESIGN.md

このドキュメントは UI デザインの単一参照点 (source of truth)。色 / 間隔 / タイポ / コンポーネントパターン / モーションを定義する。`src/index.css` のテーマ変数と各コンポーネントは、ここに書かれた値・パターンに沿って実装する。

参考にしている既存サービス: **Agoda**, **Trivago**。

## デザイン原則

1. **検索 UI は前面・大きく**: 旅行サイトでまずユーザーが触る場所は検索フォーム。トップ折り目の上に置き、視線誘導を明示する (Trivago の中央巨大検索バー)。
2. **情報密度の高い結果カード**: 横長の card に「内容 (左)」「価格 (右大きく)」「補助情報 (下小さく)」の T 字型で詰める (Agoda)。
3. **比較しやすい複数モード表示**: 同じレッグの新幹線 / 航空 / バスを同列に並べ、最安と最速をバッジで強調。
4. **過剰な装飾より色のリズム**: グラデやガラスは局所 (ヒーロー / CTA / 強調バッジ) のみ。本体は穏やかなニュートラルで読みやすく。
5. **モバイルでも一画面で完結**: 経由地 1 件・フィルタなしのときに 1 ビューで送信できる縦丈に収める。
6. **真っ黒・真っ白を使わない**: 背景は slate 寄り、文字は紺寄り。`oklch` ベースのトーンを使う。

## カラー (テーマ変数)

`src/index.css` 内で定義。Agoda 寄り (青軸 + 暖色 accent) と Trivago 寄り (緑軸) のバランスを取り、青軸 primary + 暖色 accent + 緑軸 success を併用する。

| 役割 | 変数 | 用途 |
|---|---|---|
| primary | `--primary` | 主要 CTA、強調インラインリンク、結果合計カードのベース |
| accent | `--accent` | 価格・割引・最安バッジ、ヒーローのアクセント |
| success | `--success` (新規) | 「最安」「在庫あり」「追加成功」 |
| warning | `--warning` (新規) | 「残りわずか」「混雑」 |
| destructive | `--destructive` | 削除、エラー、上限警告 |
| muted | `--muted` / `--muted-foreground` | 補助テキスト、区切り線、無効化 |
| card | `--card` | カード背景 (半透明で背景グラデが透ける) |
| border | `--border` | 罫線、入力枠 |
| ring | `--ring` | フォーカスリング (primary 60%) |

モード別配色 (交通手段) は `--mode-shinkansen / -flight / -bus / -stay` の 4 系統を維持。

## タイポグラフィ

| 用途 | サイズ | weight | line-height |
|---|---|---|---|
| Hero h1 | 4xl-5xl (clamp で flex) | 700 | 1.05 |
| Section h2 | xl-2xl | 600 | 1.2 |
| Card title | base-lg | 600 | 1.3 |
| Body | sm-base | 400 | 1.5 |
| Caption / label | xs (10-12px), uppercase tracking-wider | 500 | 1.2 |
| Price (大) | 2xl-4xl, tabular-nums | 700 | 1.1 |
| Price (小) | base-lg, tabular-nums | 600 | 1.2 |

価格は **必ず `tabular-nums`** を付ける (桁ぞろえ)。

## 間隔 (Tailwind スケール)

- カード内側: `px-5 py-4` 標準、強調カードは `px-6 py-6`
- カード間: `space-y-3` (検索結果は密度高め), `space-y-6` (セクション間)
- フォームフィールド間: `space-y-3` 内、ラベルとフィールドは `space-y-1`
- セクション間: `gap-8` (lg 以上), `gap-6` (sm)

## レイアウト

### / (ランディング)
1. **Hero**: 大型グラデ + ヘッドライン + サブコピー + 大型 CTA (検索ページへ)
2. **特徴 3 列**: 「全国 75 都市対応」「新幹線/航空/バス比較」「モック価格・APIキー不要で即試せる」
3. **CTA カード**: もう一度 CTA

### /planner (検索ページ)
1. **コンパクトヘッダー**: グラデ薄め、左にロゴ + ナビ、右に「ホームへ戻る」リンク
2. **検索パネル (Agoda 風)**: 横長カード、行内に [出発地] [人数] [行き先 (経由地)] [見積もる] を配置。経由地は展開で複数行
3. **結果エリア**:
   - 左側: フィルタサイドバー (デスクトップ; lg:block) — 当面は将来用枠だけ
   - 中央/メイン: 合計サマリ (sticky-top カード) → 区間ごとの選択肢カード群 → 宿泊カード群

### モバイル
- 検索パネルはアコーディオン化、初期は出発地+人数+「経由地を編集」ボタンのみ
- 結果はサマリ → 区間 → 宿泊の縦積み

## コンポーネントパターン

### 検索パネル (Search Panel)
Agoda の上部検索バーに倣う：
- 角丸 xl の白カード (lg) に shadow + ヒーローと −mt で重ねる
- 中の入力は h-14 大きめ、ラベルは内側左上 (上ラベル + 中値 + チェブロン右)
- 主要 CTA は右端に配置、`hero-gradient` 背景 + 白文字 + h-14

### 結果カード (Result Card)
- 横長、`grid grid-cols-[auto_1fr_auto] gap-3 p-4`
- 左: モードアイコン (size-10 円形 background)
- 中央: タイトル / 補助情報 (provider, notes)
- 右: 価格大 + 所要時間
- hover で `border-primary/40 shadow-sm`
- 最安は `border-primary ring-1 ring-primary/30 + Crown badge`

### 価格バッジ (Price Badge)
- 「最安」: bg-primary text-primary-foreground、Crown アイコン
- 「最速」: bg-accent text-accent-foreground、Zap アイコン
- 「-X%」(将来): bg-success/15 text-success-foreground

### サイドバーフィルタ (将来)
- `w-72`、`space-y-6`、各 group は h3 + Checkbox 群 + 件数
- Reset と「適用 N 件」ボタン

### フォーム入力
- セレクトは ChevronDown 重ね appearance-none、左に文脈アイコン (Filter, MapPin)
- ラベルは `text-[10px] uppercase tracking-wider text-muted-foreground`
- 数値入力は `w-32` 程度に制限

## データ取得 (Client → API)

- **必ず TanStack Query (`@tanstack/react-query`) の `useSuspenseQuery` を使う**
- `fetch` を `useState` + `useEffect` で囲む手書きパターンは禁止
- ページのトップレベル付近に `<Suspense>` と `<ErrorBoundary>` を置いて境界を作る
- 値は `data` で必ず存在する型なので、`?? []` 等の欠損フォールバックを書かない (memory: フロントで欠損フォールバックを書かない)
- mutation は `useMutation`、楽観的更新は `onMutate` / `onSettled`
- 詳しくはスキル `.claude/skills/tanstack-query-best-practices/SKILL.md` を参照
- 現状のプランナーはまだ `fetch` 直書きで実装しているため、規模が大きくなる前に `useSuspenseQuery` 化する

## モーション

- フェードアップ: `animate-fade-up` 320ms ease-out (順次 60ms ディレイ)
- ホバー: 200ms transition、translate なし、影と border のみ
- スケール: しない (旅行サイトでは派手すぎ)

## アクセシビリティ

- すべての操作要素に `aria-label`
- フォーカスリングは `focus-visible:ring-ring/50 ring-[3px]`
- 触覚的なターゲットは最低 `size-8` (32px) — モバイルは `h-10` 以上
- 色だけで情報を伝えない (バッジには必ずアイコン or テキスト)
- コントラスト: ヒーロー上の白文字には `text-shadow` または `bg-black/15` overlay

## 写真・イラスト

- MVP では使わない (ライセンス管理コスト回避)
- 代替: アイコン (Lucide) + グラデ + パターン (radial)
- 将来: Unsplash / 都市別の代表写真を CDN で

## 比較・命名

- 「経由地 (waypoint)」、「区間 (leg)」、「人数 (travelers)」、「宿泊 (stay)」 — UI もコードも揃える
- 「最安」(cheapest) は「価格」とセットで使う
- 「ホテル」「フライト」「シンカンセン」は使わず、それぞれ「宿泊」「航空」「新幹線」に揃える

## 参考スクリーンショット (運用時に追加)

`tests/snapshots/*.webp` は `bun run snapshot:ui` で再生成。シナリオは `scripts/snapshot-ui.ts` 内の `SCENARIOS` 定数に追加する。
