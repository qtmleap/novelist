# Work Plan: AI 自動小説執筆アプリへの全面刷新

Date: 2026-05-27

## Goal

旅行/運賃プランナーの中身を全面的に入れ替え、ユーザーがあらすじ（タイトル・ジャンル・登場人物・設定）を入力すると、AI が章立てを作り、各章を順に自動生成してストリーミング表示する Web アプリにする。生成した小説は D1/Prisma に保存し、一覧・再閲覧できる。

## 確定した方針

- **AI プロバイダー**: Google Gemini API。サーバー側からのみ呼び出し、`GEMINI_API_KEY` は Workers Secret。モデルは `GEMINI_MODEL` で差し替え可能（既定 `gemini-2.5-flash`、※実在モデル名は人間が最終確認）。
- **生成フロー**: 章ごと逐次生成。
  1. あらすじ入力 → Novel 行を作成（id 取得）
  2. `/novels/[id]` へ遷移 → 章立て（outline）生成
  3. 各章を順にストリーミング生成 → 章末で D1 保存
- **保存**: 既存 D1/Prisma を再利用。travel ドメインのモデルを Novel / Chapter に置換。
- **UI 言語**: ユーザー向け文言は日本語。
- **認証**: v1 ではなし（単一スコープ）。将来の multi-user は data model 拡張で対応（要注意点に記載）。

## オープンクエスチョンの決定（leader 判断）

1. **ストリーミング契約**: SSE。章生成エンドポイントは `text/event-stream` で `data: {"delta":"..."}` を逐次送出し、完了時に `data: {"done":true,"chapterId":"..."}`、エラー時に `data: {"error":"..."}` を送る。フロントの `src/lib/stream.ts` が SSE 行をパースする。
2. **stream しつつ保存**: 単一エンドポイントで `TransformStream` により全文を accumulate。Gemini ストリーム終了時に Chapter を upsert 保存してから `done` イベントを送出。
3. **Novel ID 先行取得**: `POST /api/novels` で先に Novel 行を作り id を返す → 遷移後に outline / chapter 生成。
4. **章リトライ粒度**: Chapter は `(novel_id, chapter_number)` で upsert。章単位エンドポイントなので、失敗章だけ再生成可能。
5. **コンテキスト肥大対策**: 章プロンプトには「outline 全体（各章サマリ）＋直前 1〜2 章の全文」を含める。全章全文は入れない。
6. **Gemini モデル**: env で差し替え可能、既定は速度重視の flash 系。

## Tasks

### Backend

- [x] travel ドメイン削除: `src/app/api/itinerary/`, `src/schemas/itinerary.dto.ts`, `src/lib/itinerary/`, `src/lib/regions.ts`, `src/lib/formatters.ts`(依存確認後), `prisma/seed.sql`, 旧 migration
- [x] `prisma/schema.prisma` を Novel / Chapter モデルに置換（Novel: id, title, genre, characters, setting, num_chapters, outline?, created_at, updated_at / Chapter: id, novel_id FK cascade, chapter_number, title?, content, created_at, `@@unique([novel_id, chapter_number])`）
- [x] prisma-d1 skill に従い `0001_init` migration 生成＋ローカル適用、`bunx prisma generate`
- [x] `wrangler.toml`: `database_name` を小説アプリ名に更新、`GEMINI_API_KEY` / `GEMINI_MODEL` の binding 宣言（secret は `wrangler secret put`）
- [x] `getPrisma()` を `src/lib/db.ts` へ移設（ドメイン非依存化）、`Env` 型に `GEMINI_API_KEY` / `GEMINI_MODEL` 追加
- [x] `src/lib/gemini/client.ts`: `generateOutline(env, params)` と `streamChapter(env, params)`（`streamGenerateContent?alt=sse`）。プロンプト構築をここに集約
- [x] `src/schemas/novel.dto.ts`: CreateNovelSchema / GenerateChapterRequest / Novel / Chapter / Outline スキーマ
- [x] `src/lib/novel/repository.ts`: createNovel / saveOutline / saveChapter(upsert) / getNovelWithChapters / listNovels / deleteNovel（interactive tx 不使用）
- [x] route handlers: `POST /api/novels`, `GET /api/novels`, `GET/DELETE /api/novels/[id]`, `POST /api/novels/[id]/outline`, `POST /api/novels/[id]/chapters/[number]/generate`(SSE stream + 章末保存)

### Frontend

- [x] planner UI 削除: `src/app/planner/`, `src/components/planner/*`
- [x] `src/app/page.tsx` を `/novels` へのリダイレクト/新ホームに変更
- [x] routes: `src/app/novels/page.tsx`(一覧), `src/app/novels/new/page.tsx`(あらすじ入力), `src/app/novels/[id]/page.tsx`(生成/閲覧)
- [x] `src/lib/stream.ts`: SSE フェッチを読み、`{delta}` を append、`done`/`error` を処理
- [x] components(`src/components/novel/`): PremiseForm(react-hook-form+zod), OutlineView, ChapterReader(逐次 append), GenerationStatus(進捗/中断), NovelCard, NovelSkeleton, EmptyNovels, ErrorAlert
- [x] 生成ページの状態管理: useReducer で `{outline, chapters, streamingIndex, buffer, status, error}`。章ストリーム終了で buffer を確定
- [x] shadcn 追加（未導入分）: Textarea / Select / Badge / Progress（`bunx --bun shadcn@latest add`、直接編集禁止）
- [x] ローディング/スケルトン/空/エラー状態

### QA

- [x] `bunx tsc --noEmit` エラーゼロ
- [x] `bunx biome check --write src/`
- [x] commitlint 形式でコミット（feature ブランチ、英語メッセージ、subject は小文字始まり）

## Execution Order

1. **先行（直列）**: Backend が `src/schemas/novel.dto.ts`（API 契約）と SSE ストリーミング契約を確定 → Frontend が消費
2. **並行**: Backend（schema/migration/gemini/routes）と Frontend（routes/components/stream）を同時進行。契約は上記で固定
3. **直列**: 結合確認（dev サーバーで実生成フロー）→ QA（型/lint/commit）

## Deliverables

- `prisma/schema.prisma`, `prisma/migrations/0001_init/*` — Novel/Chapter スキーマ
- `src/lib/gemini/client.ts`, `src/lib/novel/repository.ts`, `src/lib/db.ts`, `src/lib/stream.ts`
- `src/schemas/novel.dto.ts`
- `src/app/api/novels/**`, `src/app/novels/**`, `src/app/page.tsx`
- `src/components/novel/**`
- `wrangler.toml`（binding 更新）

## Risks / Notes

- **Gemini モデル名**: 実在・利用可能なモデル名は人間が確認（既定値は要検証）。
- **Workers 時間/CPU 制限**: 長い章生成が subrequest/応答タイムアウトに近づく可能性。プロンプトを簡潔に保つ＋ストリーミングで緩和。
- **コンテキスト窓**: 章数が多いと入力トークン超過。outline＋直近章のみに制限（上記決定 5）。
- **D1 `database_id`**: 現在 PLACEHOLDER。リモート適用前に人間が `wrangler d1 create` して実 ID を反映。ローカル dev は in-tree SQLite で動作。
- **D1 interactive transaction 非対応**: repository では `$transaction(async tx=>…)` を使わない。
- **作業ツリーの既存差分**: セッション開始時点で planner 系/migration/docs に未コミット差分あり。QA は本タスク関連ファイルのみ stage する。
- **認証なし**: v1 は単一スコープ。将来 multi-user 化時は Novel に owner スコープ追加が必要。
```
