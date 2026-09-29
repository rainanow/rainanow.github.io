/**
 * 自定义密码哈希器：用 `node:crypto` 的 scrypt 替换掉 `@nanokajs/auth` 自带的 `pbkdf2Hasher`。
 *
 * 为什么非换不可：
 *
 * `pbkdf2Hasher` 用的是 WebCrypto 的 `crypto.subtle.deriveBits`，迭代次数硬编码 310,000。
 * 本机实测（Node 24 / OpenSSL）：**单次约 40ms**。
 * 而 Cloudflare Workers 免费套餐的 CPU 上限是 **10ms / 请求**（付费版才给到 30 秒），
 * 一旦超了直接返回 1102 "Worker exceeded resource limits"——不是慢，是整个请求被掐掉。
 * 也就是说：登录和注册在免费套餐上必挂，而且本地 `wrangler dev` 完全测不出来
 * （本地不强制 CPU 限额），只会在线上暴露。
 *
 * 换成 `node:crypto.scrypt` 是有直接证据的：有人拿 Better Auth 在 Workers Free 上
 * 撞了同一面墙——默认的纯 JS scrypt 报 `Exceeded CPU Limit`，改成 `node:crypto.scrypt`
 * （原生实现、走 libuv 线程池，不在 isolate 线程上跑）之后就正常了。
 * 参考：https://zenn.dev/ezocraft/articles/dc9eeb3b7a7460
 *
 * scrypt 参数取 OWASP「内存受限」推荐里最省内存的一档：N=2^14, r=8 → 128*N*r = 16MB，
 * p 先给 1（想更硬就把 PARALLELISM 调大，内存不变、CPU 线性上升）。
 * 之所以不敢用 N=2^17：那是 128MB，正好等于 Workers 单 isolate 的内存上限，会 OOM。
 *
 * 存储格式自带参数：`$scrypt$N$r$p$salt$hash`（base64url）。
 * 这样以后调参数不用洗数据——旧哈希按它自己记录的参数校验。
 */

import { scrypt as scryptCallback } from 'node:crypto'
import type { ScryptOptions } from 'node:crypto'

import type { Hasher } from '@nanokajs/auth'

const ALGORITHM_ID = 'scrypt'
const COST = 16384 // N = 2^14
const BLOCK_SIZE = 8 // r
const PARALLELISM = 1 // p
const KEY_LENGTH = 64
const SALT_LENGTH = 16

/** 从哈希里读参数时 N 不能超过这个上限，防止一条被篡改的记录把 isolate 内存打爆。 */
const MAX_COST = 1 << 17

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

/**
 * 编码用 Workers 原生就有的 btoa/atob，而不是 Node 的 Buffer——
 * 少依赖一个 Node 全局，也就少一份和 workers-types 打架的机会。
 */
function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array | null {
  if (value.length === 0 || !BASE64URL_PATTERN.test(value)) return null

  const padding = (4 - (value.length % 4)) % 4
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(value.length + padding, '=')
  try {
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  } catch {
    return null
  }
}

/** 定长字节比较，耗时只与长度有关，不随内容提前返回。 */
function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

/** Node 要求 maxmem 至少是 128 * N * r，这里留一倍余量。 */
function memoryFor(cost: number, blockSize: number): number {
  return 128 * cost * blockSize * 2
}

function derive(password: string, salt: Uint8Array, options: ScryptOptions): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    // NFKC 归一化：避免「同一个密码用不同 Unicode 写法输进来」被当成两个密码。
    scryptCallback(password.normalize('NFKC'), salt, KEY_LENGTH, options, (error, derivedKey) => {
      if (error !== null) {
        reject(error)
        return
      }
      resolve(derivedKey)
    })
  })
}

export const scryptHasher: Hasher = {
  async hash(plain: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH))
    const derived = await derive(plain, salt, {
      N: COST,
      r: BLOCK_SIZE,
      p: PARALLELISM,
      maxmem: memoryFor(COST, BLOCK_SIZE),
    })

    return [
      '',
      ALGORITHM_ID,
      COST,
      BLOCK_SIZE,
      PARALLELISM,
      toBase64Url(salt),
      toBase64Url(derived),
    ].join('$')
  },

  async verify(plain: string, stored: string): Promise<boolean> {
    const parts = stored.split('$')
    // ['', 'scrypt', N, r, p, salt, hash]
    if (parts.length !== 7 || parts[0] !== '' || parts[1] !== ALGORITHM_ID) return false

    const cost = Number.parseInt(parts[2] ?? '', 10)
    const blockSize = Number.parseInt(parts[3] ?? '', 10)
    const parallelism = Number.parseInt(parts[4] ?? '', 10)
    if (!Number.isFinite(cost) || !Number.isFinite(blockSize) || !Number.isFinite(parallelism)) {
      return false
    }
    // scrypt 的硬性要求：N 必须是大于 1 的 2 的幂，r / p 必须落在合理区间。
    if (cost < 2 || cost > MAX_COST || (cost & (cost - 1)) !== 0) return false
    if (blockSize < 1 || blockSize > 64) return false
    if (parallelism < 1 || parallelism > 16) return false

    const salt = fromBase64Url(parts[5] ?? '')
    const expected = fromBase64Url(parts[6] ?? '')
    if (salt === null || expected === null) return false
    if (expected.length !== KEY_LENGTH) return false

    const derived = await derive(plain, salt, {
      N: cost,
      r: blockSize,
      p: parallelism,
      maxmem: memoryFor(cost, blockSize),
    })

    return constantTimeEqual(derived, expected)
  },
}
