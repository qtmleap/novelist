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

<!-- gh-commit-identity -->
Before creating, rewriting, signing, pushing, or delegating Git commits, read and apply gh-commit-identity at /home/vscode/app/.claude/skills/gh-commit-identity/SKILL.md. Its native checker is mandatory for new or rewritten local commits: printable ASCII English Conventional Commits, 128 counted characters maximum excluding validated final Co-Authored-By lines and their otherwise empty separator; original ASCII and attribution checks cover the whole message and other trailers remain counted, and raw Author/Committer matching the verified human github.com gh identity. Normal checks use the credential-bound cache without API calls; missing or changed cache requires --strict account. Push and native fix apply always verify online without cache fallback. Preserve recognized AI attribution. Use installed guarded Git for ordinary commits and V1 fix. Only explicitly owner-approved existing-history bulk-write may skip per-commit hooks/API; it requires frozen candidates and complete mapping verification before operator-controlled backup/CAS promotion. Never use a global ignore for new commits. Automatically correct only the skill's proven own unpublished safe subset, preserving trees and backup refs, and recheck before one authorized normal push retry. Missing tools/authentication or uncertain refs stops; repairing public/foreign history requires separate authorization. Verify actual delegated new or rewritten local commits. GitHub-generated published merge/squash/rebase history has standing authorization for preservation: establish exact OIDs and origin from live github.com refs and merged-PR metadata, retain original identities/signatures/messages, and automatically skip agent correction and approval requests for those differences. Names, emails, subjects and parent counts alone do not prove origin. Do not use standalone commits checks on this inherited history to trigger repair; use the mandatory native push/pre-push checker on actual outgoing commits. This exception grants no rewrite, force-push, ownership or migration authority and never bypasses a failed native check.
<!-- /gh-commit-identity -->
