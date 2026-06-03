// env (staging/production) 向けデプロイ。
// vinext 0.0.47 は wrangler の env を生成設定 (dist/server/wrangler.json) に引き継げず、
// 常にトップレベル (placeholder D1) を使ってしまう。そこで build 後に生成設定を
// wrangler.toml の env.<name> 値 (worker 名・D1・routes) で上書きしてから wrangler deploy する。
// 認証情報 (.env の CLOUDFLARE_API_TOKEN / ACCOUNT_ID) は Bun が自動ロードする。
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import wrangler from '../wrangler.toml'

const GENERATED_CONFIG = 'dist/server/wrangler.json'

const target = process.argv[2]
const skipBuild = process.argv.includes('--skip-build')
if (target !== 'staging' && target !== 'production') {
  console.error('usage: bun scripts/deploy.ts <staging|production> [--skip-build]')
  process.exit(1)
}

const env = wrangler.env[target]
if (env === undefined) {
  console.error(`wrangler.toml に env.${target} がありません`)
  process.exit(1)
}

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: 'inherit' })

if (!skipBuild) run('bunx', ['vinext', 'build'])

// 生成された redirect 設定を env.<target> のバインディングで上書き。
const config = JSON.parse(readFileSync(GENERATED_CONFIG, 'utf8'))
config.name = env.name
config.d1_databases = env.d1_databases
config.routes = env.routes
writeFileSync(GENERATED_CONFIG, JSON.stringify(config))
console.log(`patched ${GENERATED_CONFIG}: name=${env.name} d1=${env.d1_databases[0].database_id}`)

run('bunx', ['wrangler', 'deploy', '--config', GENERATED_CONFIG, '--keep-vars'])
