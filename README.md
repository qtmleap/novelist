# vinext-template

Vinext + React + Cloudflare Workers で始めるテンプレートリポジトリ

## 技術スタック

- [Vinext](https://github.com/nicolo-ribaudo/vinext) - Vite ベースのフレームワーク (App Router スタイル)
- [Vite 8](https://vite.dev/) - ビルドツール
- [React 19](https://react.dev/) - UI ライブラリ
- [TanStack Query](https://tanstack.com/query) - データフェッチング / キャッシュ
- [Zodios](https://www.zodios.org/) + [Zod](https://zod.dev/) - 型安全な API クライアント
- [Jotai](https://jotai.org/) - 状態管理
- [Tailwind CSS v4](https://tailwindcss.com/) - スタイリング
- [shadcn/ui](https://ui.shadcn.com/) - UI コンポーネント (New York スタイル)
- [Cloudflare Workers](https://workers.cloudflare.com/) - エッジランタイム
- [Bun](https://bun.sh/) - JavaScript ランタイム / パッケージマネージャー
- [TypeScript 5.9](https://www.typescriptlang.org/)
- [Biome](https://biomejs.dev/) - Linter / Formatter

## セットアップ

```bash
bun install
```

## 開発

```bash
bun run dev
```

http://localhost:11000 でローカルサーバーが起動します。

## ビルド

```bash
bun run build
```

## デプロイ

```bash
bun run deploy
```

Cloudflare Workers にデプロイされます。

## プロジェクト構成

```
├── app/
│   ├── layout.tsx            # ルートレイアウト
│   └── page.tsx              # トップページ
├── src/
│   ├── index.css             # グローバルスタイル (Tailwind)
│   ├── components/
│   │   ├── providers.tsx     # React プロバイダー (QueryClient 等)
│   │   └── ui/               # shadcn/ui コンポーネント
│   └── lib/
│       └── utils.ts          # ユーティリティ (cn 等)
├── public/                   # 静的ファイル
├── package.json
├── tsconfig.json
├── vite.config.ts            # Vite + Vinext + Cloudflare 設定
├── wrangler.toml             # Cloudflare Workers 設定
├── biome.json                # Biome 設定
└── components.json           # shadcn/ui 設定
```

## 開発環境

Dev Container (VSCode) で開発環境が構築されます。主な機能:

- Bun / Node.js 25
- GitHub CLI
- Docker outside of Docker
- Biome / GitLens 等の VSCode 拡張機能
