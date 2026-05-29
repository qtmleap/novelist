import { getCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import { z } from 'zod'

// CF Access が認証済みリクエストに付与するヘッダ。app コードでは JWT を検証してから
// email を読む (email-only ヘッダは CF を経由しないリクエストで容易に偽装できるため)。
const HEADER_JWT = 'Cf-Access-Jwt-Assertion'
// CF Access のセッション cookie。Access App の domain (=host) に紐付き、
// ブラウザは同 host の **全** path に送るので、Access App が一部 path だけを gate していても
// ログイン済みユーザのリクエストには cookie として JWT が付いてくる。
const COOKIE_JWT = 'CF_Authorization'

// 検証に使う JWKs を 1 時間キャッシュ。CF Access は鍵を頻繁に rotate しないが、
// 一定間隔で取り直すことでローテーションに追随する。
const JWKS_TTL_MS = 60 * 60 * 1000

// JWKs response の最小スキーマ。RSA 鍵 (kty/n/e/kid) があれば crypto.subtle.importKey で読める。
// alg/use 等の追加フィールドは passthrough で残してそのまま importKey に渡す。
const JwksKeySchema = z
  .object({
    kid: z.string().nonempty(),
    kty: z.string().nonempty()
  })
  .loose()
const JwksResponseSchema = z.object({ keys: z.array(JwksKeySchema) })
type JwksKey = z.infer<typeof JwksKeySchema>

type JwksCache = { keys: JwksKey[]; fetchedAt: number }
let jwksCache: JwksCache | null = null

type JwtClaims = {
  email: string
  iss: string
  aud: string
  exp: number
}

function getAuthEnv(): { teamDomain: string; aud: string } | null {
  const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN
  const aud = process.env.CF_ACCESS_AUD
  if (teamDomain === undefined || teamDomain.length === 0) return null
  if (aud === undefined || aud.length === 0) return null
  return { teamDomain, aud }
}

async function fetchJwks(teamDomain: string): Promise<JwksKey[]> {
  const now = Date.now()
  if (jwksCache !== null && now - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys
  const res = await fetch(`${teamDomain}/cdn-cgi/access/certs`)
  if (!res.ok) throw new Error(`failed to fetch CF Access JWKs: ${res.status}`)
  const body = JwksResponseSchema.parse(await res.json())
  jwksCache = { keys: body.keys, fetchedAt: now }
  return body.keys
}

function base64UrlDecode(input: string): Uint8Array {
  const padding = input.length % 4 === 0 ? 0 : 4 - (input.length % 4)
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padding)
  const bin = atob(padded)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

// JWT を検証して claims を返す。検証 NG なら null。
// 検証項目: 署名 (RS256), iss (team domain), aud, exp。
async function verifyAccessJwt(jwt: string, teamDomain: string, expectedAud: string): Promise<JwtClaims | null> {
  const parts = jwt.split('.')
  if (parts.length !== 3) return null
  // 個別に取り出して narrow (タプル型 as キャストを避ける)。
  const headerB64 = parts[0]
  const payloadB64 = parts[1]
  const signatureB64 = parts[2]
  if (headerB64 === undefined || payloadB64 === undefined || signatureB64 === undefined) return null

  let header: { kid?: string; alg?: string }
  try {
    header = JSON.parse(bytesToString(base64UrlDecode(headerB64)))
  } catch {
    return null
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null

  const keys = await fetchJwks(teamDomain)
  const matched = keys.find((k) => k.kid === header.kid)
  if (matched === undefined) return null

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    matched,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  )

  // crypto.subtle.verify は ArrayBuffer-backed なバッファのみ受けるので、
  // Uint8Array<ArrayBufferLike> から ArrayBuffer をコピーした Uint8Array に詰め直す。
  const signature = base64UrlDecode(signatureB64)
  const signatureBuf = new ArrayBuffer(signature.byteLength)
  new Uint8Array(signatureBuf).set(signature)
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  const dataBuf = new ArrayBuffer(data.byteLength)
  new Uint8Array(dataBuf).set(data)
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signatureBuf, dataBuf)
  if (!valid) return null

  let payload: { email?: string; iss?: string; aud?: string | string[]; exp?: number }
  try {
    payload = JSON.parse(bytesToString(base64UrlDecode(payloadB64)))
  } catch {
    return null
  }

  if (typeof payload.email !== 'string') return null
  if (typeof payload.iss !== 'string' || payload.iss !== teamDomain) return null
  // aud は string または string[] の両方を許容する仕様。
  const audMatch = Array.isArray(payload.aud) ? payload.aud.includes(expectedAud) : payload.aud === expectedAud
  if (!audMatch) return null
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null

  return { email: payload.email, iss: payload.iss, aud: expectedAud, exp: payload.exp }
}

// Hono の context に email を載せるためのキー (型は別途 module augmentation で拡張)。
type AuthVariables = { authEmail: string }

declare module 'hono' {
  interface ContextVariableMap extends AuthVariables {}
}

// リクエストから JWT を取り出す。CF Access が gate した path では header に、
// それ以外の path (= 同 host の他の URL) では cookie として届く。両方を見る。
// cookie のパースは hono/cookie の getCookie に任せる。
function pickJwt(c: Parameters<typeof getCookie>[0]): string | undefined {
  const fromHeader = c.req.header(HEADER_JWT)
  if (fromHeader !== undefined && fromHeader.length > 0) return fromHeader
  const fromCookie = getCookie(c, COOKIE_JWT)
  if (fromCookie !== undefined && fromCookie.length > 0) return fromCookie
  return undefined
}

// 認証必須エンドポイントに装着するミドルウェア。
// - CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD が未設定 (= ローカル開発) なら通す + email='dev@local'
// - 設定済みなら JWT を検証し、NG なら 401 を返す
export const requireAuth = createMiddleware(async (c, next) => {
  const env = getAuthEnv()
  if (env === null) {
    c.set('authEmail', 'dev@local')
    await next()
    return
  }

  const jwt = pickJwt(c)
  if (jwt === undefined) {
    return c.json({ error: 'unauthenticated' }, 401)
  }

  const claims = await verifyAccessJwt(jwt, env.teamDomain, env.aud)
  if (claims === null) {
    return c.json({ error: 'invalid_token' }, 401)
  }

  c.set('authEmail', claims.email)
  await next()
})

// 認証 OPTIONAL なエンドポイントから email を覗くためのヘルパ。
// 認証済みなら email、未認証 (header / cookie 無し or 失敗) なら null。
// /api/auth/me で「今ログインしてる？」を返すのに使う。
export async function readAuthEmail(c: Parameters<typeof pickJwt>[0]): Promise<string | null> {
  const env = getAuthEnv()
  if (env === null) return 'dev@local'
  const jwt = pickJwt(c)
  if (jwt === undefined) return null
  const claims = await verifyAccessJwt(jwt, env.teamDomain, env.aud)
  return claims === null ? null : claims.email
}
