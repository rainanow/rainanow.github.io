import { z } from 'zod'

const id = z.uuid()
const userId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)
const call = z.literal('call')
const webrtc = z.literal('webrtc')
const callId = id

const candidate = z.strictObject({
  candidate: z.string().max(2048),
  sdpMid: z.string().max(64).nullish(),
  sdpMLineIndex: z.number().int().min(0).max(65535).nullish(),
  usernameFragment: z.string().max(256).nullish(),
}).refine((value) => value.candidate === '' || value.sdpMid != null || value.sdpMLineIndex != null)

const schema = z.discriminatedUnion('action', [
  z.strictObject({ type: call, action: z.literal('hello') }),
  z.strictObject({ type: call, action: z.literal('invite'), requestId: id, userId }),
  z.strictObject({ type: call, action: z.literal('accept'), callId }),
  z.strictObject({ type: call, action: z.literal('reject'), callId }),
  z.strictObject({ type: call, action: z.literal('cancel'), callId }),
  z.strictObject({ type: call, action: z.literal('media-ready'), callId }),
  z.strictObject({ type: call, action: z.literal('connected'), callId }),
  z.strictObject({ type: call, action: z.literal('check'), callId }),
  z.strictObject({ type: call, action: z.literal('resume'), callId, resumeToken: id }),
  z.strictObject({
    type: call, action: z.literal('hangup'), callId,
    reason: z.enum(['device-error', 'media-error']).optional(),
  }),
  z.strictObject({ type: webrtc, action: z.literal('offer'), callId, sdp: z.string().min(1).max(32_768) }),
  z.strictObject({ type: webrtc, action: z.literal('answer'), callId, sdp: z.string().min(1).max(32_768) }),
  z.strictObject({ type: webrtc, action: z.literal('ice'), callId, candidate }),
])

export type CallInput = z.infer<typeof schema>
export type CallPhase = 'ringing' | 'connecting' | 'active'
export type CallEnd =
  | 'rejected' | 'canceled' | 'answered-elsewhere' | 'no-answer' | 'connection-timeout'
  | 'disconnected' | 'hangup' | 'device-error' | 'media-error' | 'disabled'
export type CallError =
  | 'disabled' | 'not-ready' | 'invalid-target' | 'unavailable' | 'busy'
  | 'rate-limited' | 'forbidden' | 'invalid-state' | 'ended' | 'server-error'

export interface CallPeer {
  userId: string
  username: string
}

export type CallEvent =
  | { type: 'call'; action: 'available' }
  | { type: 'call'; action: 'invited'; callId: string; requestId: string; peer: CallPeer; expiresAt: number }
  | { type: 'call'; action: 'incoming'; callId: string; peer: CallPeer; expiresAt: number }
  | {
      type: 'call'; action: 'accepted'; callId: string; role: 'caller' | 'callee';
      resumeToken: string; expiresAt: number
    }
  | { type: 'call'; action: 'negotiate' | 'active'; callId: string }
  | {
      type: 'call'; action: 'status' | 'resumed'; callId: string; phase: CallPhase;
      peerReconnecting: boolean; requestId?: string
    }
  | { type: 'call'; action: 'ended'; callId: string; reason: CallEnd }
  | { type: 'call'; action: 'error'; code: CallError; callId?: string; requestId?: string }
  | Extract<CallInput, { type: 'webrtc' }>

export function parseCallMessage(raw: string | ArrayBuffer): CallInput | undefined {
  if (typeof raw !== 'string' || raw.length > 40_000) return
  try {
    const result = schema.safeParse(JSON.parse(raw) as unknown)
    return result.success ? result.data : undefined
  } catch {
    return
  }
}
