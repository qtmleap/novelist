#!/usr/bin/env bun
// vinext build emits dist/server/wrangler.json with only the top-level
// wrangler config — the [env.staging] / [env.production] blocks from
// wrangler.toml are dropped (env: {} in the JSON, even though
// definedEnvironments lists them). To deploy to a specific env, we read
// wrangler.toml, pull the matching env block, and overwrite the relevant
// top-level keys in the JSON before calling wrangler deploy.
//
// Usage: bun scripts/inject-env-into-wrangler-json.ts staging
//        bun scripts/inject-env-into-wrangler-json.ts production

import { readFileSync, writeFileSync } from 'node:fs'
import { parse as parseToml } from 'smol-toml'

const env = process.argv[2]
if (env !== 'staging' && env !== 'production') {
  console.error(`Usage: ${process.argv[1]} <staging|production>`)
  process.exit(1)
}

const tomlPath = 'wrangler.toml'
const jsonPath = 'dist/server/wrangler.json'

const toml = parseToml(readFileSync(tomlPath, 'utf8')) as Record<string, unknown>
const envBlock = (toml.env as Record<string, Record<string, unknown>> | undefined)?.[env]
if (!envBlock) {
  console.error(`[env.${env}] not found in ${tomlPath}`)
  process.exit(1)
}

const json = JSON.parse(readFileSync(jsonPath, 'utf8')) as Record<string, unknown>

// Overwrite top-level keys with env-specific ones. Anything not present in
// the env block stays as-is (e.g. compatibility_date, main, assets).
const OVERRIDE_KEYS = [
  'name',
  'workers_dev',
  'preview_urls',
  'routes',
  'vars',
  'd1_databases',
  'kv_namespaces',
  'r2_buckets',
  'observability'
] as const

for (const key of OVERRIDE_KEYS) {
  if (key in envBlock) {
    json[key] = envBlock[key]
  }
}

writeFileSync(jsonPath, JSON.stringify(json, null, 2))
console.log(`patched ${jsonPath} with [env.${env}] (name=${json.name})`)
