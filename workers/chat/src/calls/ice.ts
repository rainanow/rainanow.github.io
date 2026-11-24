import { z } from 'zod'

import type { Env } from '../env'

export const ICE_ACCESS_PATH = '/calls/ice-access'

export const iceRequestSchema = z.strictObject({
  room: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  callId: z.uuid(),
  resumeToken: z.uuid(),
})

export const iceAccessSchema = iceRequestSchema.extend({
  userId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
})
export type IceAccess = z.infer<typeof iceAccessSchema>

const CREDENTIAL_TTL_SECONDS = 60 * 60
const CLOUDFLARE_REQUEST_TIMEOUT_MS = 5_000
const STUN_URL = /^stuns?:[^\s@/?#]+$/
const TURN_URL = /^turns?:[^\s@/?#]+(?:\?transport=(?:udp|tcp))?$/
const cloudflareIceResponse = z.object({
  iceServers: z.array(z.object({
    urls: z.array(z.string().refine((url) => STUN_URL.test(url) || TURN_URL.test(url))).min(1),
    username: z.string().min(1).optional(),
    credential: z.string().min(1).optional(),
  }).refine((server) => !server.urls.some((url) => TURN_URL.test(url)) ||
    (server.username !== undefined && server.credential !== undefined))).min(1),
})

function urls(value: string | undefined): string[] {
  if (value === undefined) return []
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

export function callRooms(value: string | undefined): Set<string> {
  return new Set(urls(value))
}

interface IceServer {
  urls: string[]
  username?: string
  credential?: string
}

interface IceConfiguration {
  iceServers: IceServer[]
  expiresAt?: number
}

async function issueCoturnIceServers(env: Env, userId: string): Promise<IceConfiguration | undefined> {
  const stun = urls(env.RTC_STUN_URLS)
  const turn = urls(env.RTC_TURN_URLS)
  if (stun.some((url) => !STUN_URL.test(url)) || turn.some((url) => !TURN_URL.test(url))) return

  const iceServers: IceServer[] = stun.length === 0 ? [] : [{ urls: stun }]
  if (turn.length === 0) return { iceServers }

  const secret = env.RTC_TURN_SECRET
  if (secret === undefined || secret.length < 32) return
  const expires = Math.floor(Date.now() / 1000) + CREDENTIAL_TTL_SECONDS
  const username = expires + ':' + userId
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(username))
  iceServers.push({ urls: turn, username, credential: btoa(String.fromCharCode(...new Uint8Array(mac))) })
  return { iceServers, expiresAt: expires * 1000 }
}

async function issueCloudflareIceServers(env: Env): Promise<IceConfiguration | undefined> {
  const keyId = env.RTC_CLOUDFLARE_TURN_KEY_ID?.trim()
  const token = env.RTC_CLOUDFLARE_TURN_TOKEN?.trim()
  if (!keyId || !/^[a-zA-Z0-9_-]+$/.test(keyId) || !token) {
    console.warn({ event: 'video_call_ice_failed', provider: 'cloudflare', reason: 'configuration' })
    return
  }

  const expiresAt = Date.now() + CREDENTIAL_TTL_SECONDS * 1000
  try {
    const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: CREDENTIAL_TTL_SECONDS }),
      signal: AbortSignal.timeout(CLOUDFLARE_REQUEST_TIMEOUT_MS),
      redirect: 'manual',
    })
    if (!response.ok) {
      console.warn({ event: 'video_call_ice_failed', provider: 'cloudflare', reason: 'http', status: response.status })
      await response.body?.cancel().catch(() => {})
      return
    }

    const parsed = cloudflareIceResponse.safeParse(await response.json().catch(() => undefined))
    if (parsed.success) {
      // 浏览器通常阻止 53 端口。保留服务返回的 UDP、TCP 和 TLS 其他端口。
      const iceServers = parsed.data.iceServers
        .map((server) => ({ ...server, urls: server.urls.filter((url) => !/:53(?:\?|$)/.test(url)) }))
        .filter((server) => server.urls.length > 0)
      if (iceServers.some((server) => server.urls.some((url) => TURN_URL.test(url)))) {
        return { iceServers, expiresAt }
      }
    }
    console.warn({ event: 'video_call_ice_failed', provider: 'cloudflare', reason: 'response' })
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network'
    console.warn({ event: 'video_call_ice_failed', provider: 'cloudflare', reason })
  }
}

/** 保持浏览器的 ICE 配置格式，长期密钥留在 Worker。 */
export async function issueIceServers(env: Env, userId: string): Promise<IceConfiguration | undefined> {
  const provider = env.RTC_TURN_PROVIDER ?? 'coturn'
  if (provider === 'cloudflare') return issueCloudflareIceServers(env)
  if (provider === 'coturn') {
    const configuration = await issueCoturnIceServers(env, userId)
    if (configuration === undefined) {
      console.warn({ event: 'video_call_ice_failed', provider, reason: 'configuration' })
    }
    return configuration
  }
  console.warn({ event: 'video_call_ice_failed', reason: 'unknown_provider' })
}
