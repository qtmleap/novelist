# CLAUDE.md

## プロジェクト概要

Vinext (Vite ベース App Router) + React 19 + Cloudflare Workers の Web アプリケーション。

## コマンド

- `bun install` - 依存関係のインストール
- `bun run dev` - 開発サーバー起動 (port 11599)
- `bun run build` - プロダクションビルド
- `bun run deploy` - Cloudflare Workers へデプロイ

## コーディング規約

- **言語**: TypeScript (strict モード)
- **型チェック**: `bunx tsc --noEmit` でエラーゼロを維持すること
- **Linter/Formatter**: Biome (`bunx biome check --write` で修正)
- **変更後は必ず** `bunx biome check --write` と `bunx tsc --noEmit` の両方を通すこと
  - インデント: スペース 2
  - セミコロン: 不要時省略 (`asNeeded`)
  - クォート: シングルクォート
  - JSX クォート: シングルクォート
  - トレーリングカンマ: なし
  - 行幅: JS/TS は 120、その他は 80
- **className の条件分岐**: テンプレートリテラルでのインライン展開禁止。`cn()` (`@/lib/utils`) を使用すること
- **パスエイリアス**: `@/*` → `./src/*`
- **パッケージマネージャー**: Bun (npm/yarn/pnpm は使わない)

## アーキテクチャ

- `src/app/` - Vinext App Router (layout.tsx, page.tsx でファイルベースルーティング)
- `src/components/ui/` - shadcn/ui コンポーネント (`bunx --bun shadcn@latest add <name>` で追加、**直接編集禁止**、className で上書き)
- `src/components/` - アプリ固有のコンポーネント
- `src/lib/` - ユーティリティ関数
- `vite.config.ts` - Vinext + Cloudflare Vite Plugin + Tailwind CSS
- `wrangler.toml` - Workers 設定 (nodejs_compat)

## 重要な注意事項

- shadcn/ui は New York スタイル、Lucide アイコン使用
- **shadcn/ui コンポーネントは直接編集しない** — スタイル変更は利用側で className を渡して対応
- shadcn/ui コンポーネントの追加: `bunx --bun shadcn@latest add <component-name>`
- tsconfig で `src/components/ui/**/*.tsx` は型チェック対象外
- Cloudflare Workers の `compatibility_date` は `2026-01-01`
