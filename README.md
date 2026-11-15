# Novelist

登場人物・作品設定・章を管理し、Gemini による小説の執筆を支援する Web アプリケーションです。汎用テンプレートではなく、作品とキャラクターを継続して編集するための画面・API・データモデルを実装しています。

## 実装している機能

- 作品の作成・編集・分類、登場人物の登録、キャストと人物間の関係の管理
- キャラクターのバリエーションと、章ごとの本文・生成プロンプトの保存
- Gemini による章生成とストリーミング表示
- Durable Objects による章生成ジョブの管理、生成コストの記録
- 生成の中断理由の表示と、生成できた本文の保存
- Cloudflare Access の JWT 検証による認証（認証設定がないローカル環境では開発用ユーザーを使用）

一般公開・本番稼働の状態は、この機能一覧だけでは保証しません。

## 技術スタック

- TypeScript、React、Vinext、Vite、Tailwind CSS、shadcn/ui
- Hono、Zod、Zodios、TanStack Query、Jotai
- Cloudflare Workers、D1、Durable Objects、Prisma
- Gemini API、Cloudflare Access、Bun、Biome

依存パッケージのバージョンは `package.json` と `bun.lock` を参照してください。

## セットアップと開発

```bash
bun install --frozen-lockfile
DATABASE_URL=file:./dev.db bunx prisma generate
bun run dev
```

開発サーバーは `package.json` の指定により `http://localhost:11675` で起動します。D1 のスキーマは `prisma/migrations/` にあります。ローカル DB に適用し、章生成を利用する場合は Worker の `GEMINI_API_KEY` を設定してください。

Worker の `DB`・`CHAPTER_GEN` bindings は `wrangler.toml`、Prisma のローカル接続は `prisma.config.ts`、認証は `src/server/auth.ts` を参照してください。本番で認証を利用する場合は `CF_ACCESS_TEAM_DOMAIN` と `CF_ACCESS_AUD` を設定し、Cloudflare Access 側の構成も用意します。秘密値は Git 管理外の環境設定で渡します。

## 検査とビルド

```bash
bun test
bunx biome check
bunx tsc --noEmit
bun run build
```

型検査・ビルドの前に Prisma client を生成してください。

## デプロイ

```bash
bun run deploy:staging
bun run deploy:production
```

`scripts/deploy.sh` がビルド時の Cloudflare 環境を選択します。Cloudflare の認証情報と、対象環境の DB・bindings・秘密値を用意してから実行してください。

## プロジェクト構成

| 場所 | 内容 |
| --- | --- |
| `src/app/` | 作品・登場人物・章・設定の画面と API 入口 |
| `src/server/` | Hono API と Cloudflare Access 認証 |
| `src/lib/novel/`、`src/lib/character/` | 保存処理と章生成用データの組み立て |
| `src/lib/gemini/` | Gemini クライアント |
| `src/lib/chapter-gen-do.ts` | 章生成 Durable Object |
| `prisma/` | DB スキーマとマイグレーション |
| `tests/` | テスト |
| `scripts/` | 環境別デプロイなどの補助スクリプト |

Dev Container の構成は `.devcontainer/` にあります。
