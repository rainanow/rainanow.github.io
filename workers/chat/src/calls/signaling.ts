import type { SocketAttachment } from '../types'
import { callRooms } from './ice'
import type { IceAccess } from './ice'
import { parseCallMessage } from './protocol'
import type { CallEnd, CallError, CallEvent, CallInput, CallPeer, CallPhase, RoomCall, RoomCallSnapshot } from './protocol'

const RING_MS = 30_000
const CONNECT_MS = 45_000
const RESUME_MS = 15_000
const INVITE_WINDOW_MS = 60_000
const INVITES_PER_WINDOW = 10
const RECIPIENT_COOLDOWN_MS = 4_000
const REQUEST_TTL_MS = 120_000

const SESSION = 'video:session:'
const USER = 'video:user:'
const TEMP = 'video:temp:'

type Connection = SocketAttachment & { connectionId: string; sessionId: string }
type CallAccount = Pick<Connection, 'userId' | 'sessionId'>
export type CallDeparture = 'session-revoked' | 'page-closed'
type Invite = Extract<CallInput, { action: 'invite' | 'invite-room' }>
type Accept = Extract<CallInput, { action: 'accept' | 'join' }>
type Resume = Extract<CallInput, { action: 'resume' }>

interface Binding {
  connectionId: string
  sessionId?: string
  expiresAt: number
  tokenDigest?: string
  reconnectBy?: number
}

interface Participant extends CallPeer {
  binding?: Binding
  ready?: true
  connected?: true
}

interface Session {
  id: string
  room: string
  phase: CallPhase
  createdAt?: number
  publicInvite?: true
  deadline?: number
  participants: [Participant, Participant?]
  ringing: string[]
  offerSent?: true
  answerSent?: true
}

interface Temporary<T> {
  value: T
  expiresAt: number
}

interface InviteReceipt {
  callId: string
  connectionId: string
  userId?: string
}

interface Budget {
  count: number
  until: number
}

function peer(identity: CallPeer): CallPeer {
  return { userId: identity.userId, username: identity.username }
}

function bind(identity: Connection, tokenDigest?: string): Binding {
  return { connectionId: identity.connectionId, sessionId: identity.sessionId, expiresAt: identity.exp * 1000, tokenDigest }
}

async function digest(token: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function callSocketTags(userId: string, connectionId: string): [string, string] {
  return ['call-user:' + userId, 'call-socket:' + connectionId]
}

/** 一个 ChatRoom 管理本房间的通话。SQLite 保存状态，WebSocket 附件保存连接身份。 */
export class CallSignaling {
  private readonly rooms: Set<string>
  private readonly frames = new WeakMap<WebSocket, Budget>()
  private readonly candidates = new WeakMap<WebSocket, Budget>()
  private alarmDirty = false
  private alarmAt: number | null | undefined

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly db: D1Database,
    rooms: string | undefined,
    private readonly departed: WeakSet<WebSocket>,
  ) {
    this.rooms = callRooms(rooms)
  }

  enabled(room: string): boolean {
    return this.rooms.has(room)
  }

  sendRoomSnapshot(ws: WebSocket): void {
    const identity = this.connection(ws)
    if (identity === undefined || !this.enabled(identity.room)) return
    this.sendJson(ws, JSON.stringify(this.roomSnapshot(identity.room)))
  }

  private roomSnapshot(room: string): RoomCallSnapshot {
    const calls: RoomCall[] = []
    const now = Date.now()
    for (const [, session] of this.kv.list<Session>({ prefix: SESSION })) {
      if (session.room !== room || (!session.publicInvite && session.phase !== 'active') ||
          (session.deadline !== undefined && session.deadline <= now)) continue
      const [caller, callee] = session.participants
      if (callee === undefined && session.phase !== 'ringing') continue
      calls.push({
        callId: session.id,
        caller: peer(caller),
        callee: callee === undefined ? undefined : peer(callee),
        phase: session.phase,
        createdAt: session.createdAt ?? 0,
        expiresAt: session.deadline,
        publicInvite: session.publicInvite === true,
      })
    }
    calls.sort((left, right) => left.createdAt - right.createdAt || left.callId.localeCompare(right.callId))
    return { type: 'call-room', calls }
  }

  private publishRoom(room: string): void {
    const payload = JSON.stringify(this.roomSnapshot(room))
    for (const ws of this.ctx.getWebSockets()) {
      if (this.connection(ws)?.room === room) this.sendJson(ws, payload)
    }
  }

  async canIssueIce(input: IceAccess): Promise<boolean> {
    if (!this.enabled(input.room)) return false
    const tokenDigest = await digest(input.resumeToken)
    const session = this.iceSession(input, tokenDigest)
    if (session === undefined) return false
    const caller = this.participantAccount(session.participants[0])
    const callee = this.participantAccount(session.participants[1])
    if (caller === undefined || callee === undefined || !await this.accountsCanCall(caller, callee)) return false
    // 账号查询期间会话可能已经挂断。签发前以当前状态为准。
    const current = this.iceSession(input, tokenDigest)
    if (current === undefined) return false
    const allowed = this.reconcile(current, Date.now())
    await this.armAlarm()
    return allowed
  }

  private iceSession(input: IceAccess, tokenDigest: string): Session | undefined {
    const session = this.kv.get<Session>(SESSION + input.callId)
    if (session === undefined || session.room !== input.room || session.phase === 'ringing') return
    const participant = session.participants.find((member) => member?.userId === input.userId)
    if (participant?.binding?.tokenDigest === tokenDigest && this.boundSocket(participant.binding) !== undefined) {
      return session
    }
  }

  private get kv(): SyncKvStorage {
    return this.ctx.storage.kv
  }

  async receive(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const identity = this.connection(ws)
    if (identity === undefined || !this.take(this.frames, ws, 160)) return
    const input = parseCallMessage(raw)
    if (input === undefined) return

    try {
      if (!this.enabled(identity.room)) {
        const session = this.sessionForUser(identity.userId)
        if (session !== undefined) this.finish(session, 'disabled')
        this.error(ws, 'disabled', input)
      } else if (input.action === 'hello') {
        ws.serializeAttachment({ ...identity, callReady: true } satisfies Connection)
        this.send(ws, { type: 'call', action: 'available' })
      } else if (!identity.callReady) {
        this.error(ws, 'not-ready', input)
      } else if (input.action === 'invite' || input.action === 'invite-room') {
        await this.invite(ws, identity, input)
      } else if (input.action === 'accept' || input.action === 'join') {
        await this.accept(ws, identity, input)
      } else if (input.action === 'resume') {
        await this.resume(ws, identity, input)
      } else {
        this.receiveForSession(ws, identity, input)
      }
    } catch {
      // 只记录事件种类，避免误写 SDP、ICE 或凭证。
      console.error('视频通话信令处理失败', input.action)
      this.error(ws, 'server-error', input)
    } finally {
      await this.armAlarm()
    }
  }

  async departure(identity: SocketAttachment, departure?: CallDeparture): Promise<void> {
    if (identity.connectionId === undefined || !identity.callReady) return
    const session = this.sessionForUser(identity.userId)
    if (session === undefined) return
    const binding = session.participants.find((member) => member?.userId === identity.userId)?.binding
    const boundSocket = binding?.connectionId === identity.connectionId
    if (departure === 'session-revoked' && binding !== undefined &&
        (binding.sessionId === identity.sessionId || boundSocket)) {
      this.finish(session, 'disconnected')
    } else if (departure === 'page-closed' && boundSocket) {
      this.finish(session, 'hangup')
    } else {
      this.reconcile(session, Date.now())
    }
    await this.armAlarm()
  }

  async alarm(): Promise<void> {
    this.alarmAt = undefined
    this.alarmDirty = true
    const now = Date.now()
    for (const [, session] of this.kv.list<Session>({ prefix: SESSION })) {
      this.reconcile(session, now)
    }
    for (const [key, item] of this.kv.list<Temporary<unknown>>({ prefix: TEMP })) {
      if (item.expiresAt <= now) this.kv.delete(key)
    }
    await this.armAlarm()
  }

  private async invite(ws: WebSocket, identity: Connection, input: Invite): Promise<void> {
    const targetId = input.action === 'invite' ? input.userId : undefined
    if (identity.userId === targetId) return this.error(ws, 'invalid-target', input)
    const receiptKey = 'request:' + identity.userId + ':' + input.requestId
    const cooldownKey = targetId === undefined ? undefined : 'recipient:' + identity.userId + ':' + targetId
    let now = Date.now()
    if (this.replyToRetry(ws, identity, input, receiptKey, now)) return
    if (!this.takeInvite(identity.userId, now) ||
        (cooldownKey !== undefined && this.getTemporary(cooldownKey, now) !== undefined)) {
      return this.error(ws, 'rate-limited', input)
    }
    await this.armAlarm()
    const target = targetId === undefined ? undefined : this.callableSockets(targetId, identity.room)[0]?.identity
    if ((targetId !== undefined && target === undefined) || !await this.accountsCanCall(identity, target)) {
      return this.error(ws, 'unavailable', input)
    }

    // D1 查询之后重新读取 WebSocket 和名额。检查与占用之间没有异步操作。
    now = Date.now()
    if (this.connection(ws) === undefined) return
    if (this.replyToRetry(ws, identity, input, receiptKey, now)) return
    const recipients = target === undefined ? [] : this.callableSockets(target.userId, identity.room)
      .filter((entry) => entry.identity.sessionId === target.sessionId)
    const callee = recipients[0]?.identity
    if (targetId !== undefined && callee === undefined) return this.error(ws, 'unavailable', input)
    if (this.isBusy(identity.userId, now) || (callee !== undefined && this.isBusy(callee.userId, now))) {
      return this.error(ws, 'busy', input)
    }
    if (cooldownKey !== undefined && this.getTemporary(cooldownKey, now) !== undefined) {
      return this.error(ws, 'rate-limited', input)
    }

    const expiresAt = now + RING_MS
    const session: Session = {
      id: crypto.randomUUID(),
      room: identity.room,
      phase: 'ringing',
      createdAt: now,
      deadline: expiresAt,
      participants: [{ ...peer(identity), binding: bind(identity) }],
      ringing: recipients.map((entry) => entry.identity.connectionId),
    }
    if (callee === undefined) session.publicInvite = true
    else session.participants[1] = peer(callee)
    this.ctx.storage.transactionSync(() => {
      this.save(session)
      this.kv.put(USER + identity.userId, session.id)
      if (callee !== undefined) this.kv.put(USER + callee.userId, session.id)
      this.putTemporary<InviteReceipt>(
        receiptKey, { callId: session.id, connectionId: identity.connectionId, userId: targetId },
        now + REQUEST_TTL_MS,
      )
      if (cooldownKey !== undefined) this.putTemporary(cooldownKey, true, now + RECIPIENT_COOLDOWN_MS)
    })
    this.send(ws, {
      type: 'call', action: 'invited', callId: session.id, requestId: input.requestId,
      peer: callee === undefined ? undefined : peer(callee), expiresAt,
    })
    if (session.publicInvite) this.publishRoom(session.room)
    for (const recipient of recipients) {
      this.send(recipient.ws, {
        type: 'call', action: 'incoming', callId: session.id, peer: peer(identity), expiresAt,
      })
    }
  }

  private replyToRetry(
    ws: WebSocket, identity: Connection, input: Invite, key: string, now: number,
  ): boolean {
    const receipt = this.getTemporary<InviteReceipt>(key, now)
    if (receipt === undefined) return false
    const targetId = input.action === 'invite' ? input.userId : undefined
    if (identity.connectionId !== receipt.connectionId || targetId !== receipt.userId) {
      this.error(ws, 'invalid-state', input)
      return true
    }
    const session = this.kv.get<Session>(SESSION + receipt.callId)
    if (session === undefined || !this.reconcile(session, now)) {
      this.error(ws, 'ended', input)
    } else if (session.phase === 'ringing' && session.deadline !== undefined) {
      const callee = session.participants[1]
      this.send(ws, {
        type: 'call', action: 'invited', callId: session.id, requestId: input.requestId,
        peer: callee === undefined ? undefined : peer(callee), expiresAt: session.deadline,
      })
    } else if (session.participants[0].binding?.connectionId === identity.connectionId) {
      this.sendStatus(ws, session, 0, 'status', input.requestId)
    } else {
      this.error(ws, 'forbidden', input)
    }
    return true
  }

  private attending(ws: WebSocket, identity: Connection, input: Accept): Session | undefined {
    const session = this.kv.get<Session>(SESSION + input.callId)
    const joining = input.action === 'join'
    if (joining && session === undefined) {
      this.error(ws, 'ended', input)
      return
    }
    if (!this.matches(session, identity)) {
      this.error(ws, 'forbidden', input)
      return
    }
    const [caller, callee] = session.participants
    const eligible = joining ? session.publicInvite && caller.userId !== identity.userId
      : !session.publicInvite && callee?.userId === identity.userId
    if (!eligible) {
      this.error(ws, 'forbidden', input)
      return
    }
    if (session.phase !== 'ringing') {
      if (callee?.binding?.connectionId === identity.connectionId &&
          this.reconcile(session, Date.now())) this.sendStatus(ws, session, 1)
      else this.error(ws, 'invalid-state', input)
      return
    }
    if (!joining && !session.ringing.includes(identity.connectionId)) {
      this.error(ws, 'forbidden', input)
      return
    }
    const now = Date.now()
    if (!this.reconcile(session, now)) {
      if (joining) this.error(ws, 'ended', input)
      return
    }
    if (joining && this.isBusy(identity.userId, now)) {
      this.error(ws, 'busy', input)
      return
    }
    return session
  }

  private async accept(ws: WebSocket, identity: Connection, input: Accept): Promise<void> {
    const ringing = this.attending(ws, identity, input)
    if (ringing === undefined) return
    const callerConnection = this.boundConnection(ringing.participants[0].binding)
    if (callerConnection === undefined || !await this.accountsCanCall(callerConnection, identity)) {
      // 校验期间另一标签页可能已接听，保留已提交的决定。
      const current = this.attending(ws, identity, input)
      if (current !== undefined) {
        if (input.action === 'join') this.error(ws, 'unavailable', input)
        else this.finish(current, 'disconnected')
      }
      return
    }
    const callerToken = crypto.randomUUID()
    const calleeToken = crypto.randomUUID()
    const [callerDigest, calleeDigest] = await Promise.all([digest(callerToken), digest(calleeToken)])
    if (this.connection(ws) === undefined) return
    const session = this.attending(ws, identity, input)
    if (session === undefined) return
    const [caller, invited] = session.participants
    const binding = caller.binding
    if (binding === undefined) return
    const callee: Participant = invited ?? peer(identity)

    const otherTabs = this.ringingSockets(session).filter((socket) => socket !== ws)
    const expiresAt = Date.now() + CONNECT_MS
    // 异步校验结束后重新读状态，紧接着同时写入第二位参与者和账号锁。
    this.ctx.storage.transactionSync(() => {
      binding.tokenDigest = callerDigest
      callee.binding = bind(identity, calleeDigest)
      session.participants[1] = callee
      session.phase = 'connecting'
      session.deadline = expiresAt
      session.ringing = []
      this.save(session)
      if (session.publicInvite) this.kv.put(USER + identity.userId, session.id)
    })
    this.sendTo(caller, {
      type: 'call', action: 'accepted', role: 'caller', callId: session.id,
      resumeToken: callerToken, expiresAt, peer: peer(callee),
    })
    this.send(ws, {
      type: 'call', action: 'accepted', role: 'callee', callId: session.id,
      resumeToken: calleeToken, expiresAt, peer: peer(caller),
    })
    for (const tab of otherTabs) {
      this.send(tab, { type: 'call', action: 'ended', callId: session.id, reason: 'answered-elsewhere' })
    }
    if (session.publicInvite) this.publishRoom(session.room)
  }

  private async resume(ws: WebSocket, identity: Connection, input: Resume): Promise<void> {
    const tokenDigest = await digest(input.resumeToken)
    if (this.connection(ws) === undefined) return
    const session = this.kv.get<Session>(SESSION + input.callId)
    if (!this.matches(session, identity) || session.phase !== 'active') {
      return this.error(ws, 'forbidden', input)
    }
    const index = session.participants[0].userId === identity.userId ? 0 : 1
    const participant = session.participants[index]
    const binding = participant?.binding
    if (participant?.userId !== identity.userId || binding?.tokenDigest !== tokenDigest ||
        (binding.sessionId !== undefined && binding.sessionId !== identity.sessionId)) {
      return this.error(ws, 'forbidden', input)
    }
    if (!this.reconcile(session, Date.now())) return this.error(ws, 'ended', input)
    participant.binding = bind(identity, tokenDigest)
    this.save(session)
    this.sendStatus(ws, session, index, 'resumed')
    this.sendStatusToPeer(session, index)
  }

  private receiveForSession(
    ws: WebSocket,
    identity: Connection,
    input: Exclude<CallInput, Invite | Accept | Resume | { action: 'hello' }>,
  ): void {
    const session = this.kv.get<Session>(SESSION + input.callId)
    if (!this.matches(session, identity)) return this.error(ws, 'forbidden', input)
    const [caller, callee] = session.participants
    const index = caller.userId === identity.userId ? 0 : 1
    const participant = session.participants[index]
    const isSelected = participant?.userId === identity.userId &&
      participant.binding?.connectionId === identity.connectionId
    const canReject = input.action === 'reject' && session.phase === 'ringing' && !session.publicInvite &&
      callee?.userId === identity.userId && session.ringing.includes(identity.connectionId)
    if (!isSelected && !canReject) return this.error(ws, 'forbidden', input)
    if (!this.reconcile(session, Date.now())) return

    if (input.type === 'webrtc') {
      this.relay(ws, session, index, input)
      return
    }
    switch (input.action) {
      case 'reject':
        if (canReject) return this.finish(session, 'rejected')
        break
      case 'cancel':
        // 发出取消时，另一位可能已经接受邀请，客户端尚未收到 accepted。
        if (index === 0 && session.phase !== 'active') return this.finish(session, 'canceled')
        break
      case 'hangup':
        if (session.phase !== 'ringing') return this.finish(session, input.reason ?? 'hangup')
        break
      case 'check':
        return this.sendStatus(ws, session, index)
      case 'media-ready':
        if (session.phase !== 'connecting' || participant === undefined || callee === undefined) break
        if (participant.ready) return
        participant.ready = true
        this.save(session)
        if (caller.ready && callee.ready) this.sendBoth(session, { type: 'call', action: 'negotiate', callId: session.id })
        return
      case 'connected':
        if (participant === undefined || callee === undefined) break
        if (participant.connected) return
        if (session.phase !== 'connecting' || !session.answerSent) break
        participant.connected = true
        if (caller.connected && callee.connected) {
          session.phase = 'active'
          delete session.deadline
          this.save(session)
          console.info({ event: 'video_call_connected', room: session.room, callId: session.id })
          this.sendBoth(session, { type: 'call', action: 'active', callId: session.id })
          this.publishRoom(session.room)
        } else {
          this.save(session)
        }
        return
    }
    this.error(ws, 'invalid-state', input)
  }

  private relay(
    ws: WebSocket, session: Session, index: 0 | 1, input: Extract<CallInput, { type: 'webrtc' }>,
  ): void {
    if (session.phase === 'ringing' || !session.participants.every((participant) => participant?.ready)) {
      return this.error(ws, 'invalid-state', input)
    }
    if (input.action === 'offer') {
      if (index !== 0 || session.offerSent) return this.error(ws, 'invalid-state', input)
      session.offerSent = true
      this.kv.put(SESSION + session.id, session)
    } else if (input.action === 'answer') {
      if (index !== 1 || !session.offerSent || session.answerSent) return this.error(ws, 'invalid-state', input)
      session.answerSent = true
      this.kv.put(SESSION + session.id, session)
    } else if (!this.take(this.candidates, ws, 96)) {
      return
    }
    this.sendTo(session.participants[index === 0 ? 1 : 0], input)
  }

  /** 同一条连接的 close/error 可重复到达，重新绑定后的旧连接也可能迟到。 */
  private reconcile(session: Session, now: number): boolean {
    if (!this.enabled(session.room)) return this.end(session, 'disabled')
    const [caller, callee] = session.participants
    if (session.phase !== 'active') {
      if (session.deadline !== undefined && session.deadline <= now) {
        return this.end(session, session.phase === 'ringing' ? 'no-answer' : 'connection-timeout')
      }
      const calleePresent = session.phase === 'ringing'
        ? session.publicInvite || this.ringingSockets(session).length > 0
        : this.boundSocket(callee?.binding) !== undefined
      if (this.boundSocket(caller.binding) === undefined || !calleePresent) {
        return this.end(session, 'disconnected')
      }
      return true
    }

    if (callee === undefined) return this.end(session, 'disconnected')
    let changed = false
    for (const participant of session.participants) {
      const binding = participant?.binding
      if (binding === undefined) return this.end(session, 'disconnected')
      if (binding.reconnectBy === undefined && this.boundSocket(binding) === undefined) {
        binding.reconnectBy = Math.min(now, binding.expiresAt) + RESUME_MS
        changed = true
      }
      if (binding.reconnectBy !== undefined && binding.reconnectBy <= now) {
        return this.end(session, 'disconnected')
      }
    }
    if (changed) {
      this.save(session)
      this.sendStatusToPeer(session, 0)
      this.sendStatusToPeer(session, 1)
    }
    return true
  }

  private end(session: Session, reason: CallEnd): false {
    this.finish(session, reason)
    return false
  }

  private finish(session: Session, reason: CallEnd): void {
    this.ctx.storage.transactionSync(() => {
      this.kv.delete(SESSION + session.id)
      for (const participant of session.participants) {
        if (participant === undefined) continue
        const key = USER + participant.userId
        if (this.kv.get<string>(key) === session.id) this.kv.delete(key)
      }
    })
    this.alarmDirty = true
    console.info({ event: 'video_call_ended', room: session.room, callId: session.id, phase: session.phase, reason })
    const event = { type: 'call', action: 'ended', callId: session.id, reason } as const
    this.sendBoth(session, event)
    for (const ws of this.ringingSockets(session)) this.send(ws, event)
    if (session.publicInvite || session.phase === 'active') this.publishRoom(session.room)
  }

  private matches(session: Session | undefined, identity: Connection): session is Session {
    return session?.room === identity.room
  }

  private sessionForUser(userId: string): Session | undefined {
    const id = this.kv.get<string>(USER + userId)
    return id === undefined ? undefined : this.kv.get<Session>(SESSION + id)
  }

  private isBusy(userId: string, now: number): boolean {
    const session = this.sessionForUser(userId)
    return session !== undefined && this.reconcile(session, now)
  }

  private save(session: Session): void {
    this.kv.put(SESSION + session.id, session)
    this.alarmDirty = true
  }

  private async armAlarm(): Promise<void> {
    if (!this.alarmDirty) return
    let next = Infinity
    for (const [, session] of this.kv.list<Session>({ prefix: SESSION })) {
      next = Math.min(next, session.deadline ?? Infinity)
      for (const participant of session.participants) {
        const binding = participant?.binding
        if (binding !== undefined) next = Math.min(next, binding.reconnectBy ?? binding.expiresAt)
      }
    }
    for (const [, item] of this.kv.list<Temporary<unknown>>({ prefix: TEMP })) {
      next = Math.min(next, item.expiresAt)
    }
    const due = Number.isFinite(next) ? next : null
    this.alarmDirty = false
    if (this.alarmAt === due) return
    this.alarmAt = due
    try {
      if (due === null) await this.ctx.storage.deleteAlarm()
      else await this.ctx.storage.setAlarm(due)
    } catch (error) {
      if (this.alarmAt === due) {
        this.alarmAt = undefined
        this.alarmDirty = true
      }
      throw error
    }
  }

  private connection(ws: WebSocket): Connection | undefined {
    if (ws.readyState !== WebSocket.OPEN || this.departed.has(ws)) return
    const identity = ws.deserializeAttachment() as SocketAttachment | null
    if (identity?.connectionId === undefined || typeof identity.sessionId !== 'string' ||
        !(identity.exp * 1000 > Date.now())) return
    return { ...identity, connectionId: identity.connectionId, sessionId: identity.sessionId }
  }

  private callableSockets(userId: string, room: string): { ws: WebSocket; identity: Connection }[] {
    const found: { ws: WebSocket; identity: Connection }[] = []
    for (const ws of this.ctx.getWebSockets('call-user:' + userId)) {
      const identity = this.connection(ws)
      if (identity?.callReady === true && identity.userId === userId && identity.room === room) {
        found.push({ ws, identity })
      }
    }
    return found
  }

  private socketById(connectionId: string): WebSocket | undefined {
    return this.ctx.getWebSockets('call-socket:' + connectionId)
      .find((ws) => this.connection(ws)?.callReady)
  }

  private boundSocket(binding: Binding | undefined): WebSocket | undefined {
    if (binding === undefined || binding.reconnectBy !== undefined) return
    return this.socketById(binding.connectionId)
  }

  private boundConnection(binding: Binding | undefined): Connection | undefined {
    const socket = this.boundSocket(binding)
    return socket === undefined ? undefined : this.connection(socket)
  }

  private participantAccount(participant: Participant | undefined): CallAccount | undefined {
    if (participant === undefined) return
    const sessionId = participant.binding?.sessionId ?? this.boundConnection(participant.binding)?.sessionId
    return sessionId === undefined ? undefined : { userId: participant.userId, sessionId }
  }

  private ringingSockets(session: Session): WebSocket[] {
    const sockets: WebSocket[] = []
    for (const id of session.ringing) {
      const ws = this.socketById(id)
      if (ws !== undefined) sockets.push(ws)
    }
    return sockets
  }

  private sendTo(participant: Participant | undefined, event: CallEvent): void {
    const ws = this.boundSocket(participant?.binding)
    if (ws !== undefined) this.send(ws, event)
  }

  private sendBoth(session: Session, event: CallEvent): void {
    for (const participant of session.participants) this.sendTo(participant, event)
  }

  private sendStatusToPeer(session: Session, index: 0 | 1): void {
    const opposite = index === 0 ? 1 : 0
    const ws = this.boundSocket(session.participants[opposite]?.binding)
    if (ws !== undefined) this.sendStatus(ws, session, opposite)
  }

  private sendStatus(
    ws: WebSocket, session: Session, index: 0 | 1, action: 'status' | 'resumed' = 'status',
    requestId?: string,
  ): void {
    this.send(ws, {
      type: 'call', action, callId: session.id, phase: session.phase, requestId,
      peerReconnecting: session.participants[index === 0 ? 1 : 0]?.binding?.reconnectBy !== undefined,
    })
  }

  private send(ws: WebSocket, event: CallEvent): void {
    this.sendJson(ws, JSON.stringify(event))
  }

  private sendJson(ws: WebSocket, json: string): void {
    try {
      ws.send(json)
    } catch {
      // 连接关闭后的清理由 departure 或 Alarm 处理。
    }
  }

  private error(ws: WebSocket, code: CallError, input: CallInput): void {
    this.send(ws, {
      type: 'call', action: 'error', code,
      callId: 'callId' in input ? input.callId : undefined,
      requestId: 'requestId' in input ? input.requestId : undefined,
    })
  }

  private async accountsCanCall(caller: CallAccount, callee?: CallAccount): Promise<boolean> {
    const now = Date.now()
    const { results } = await this.db.prepare(
      `SELECT u.id FROM users AS u
       WHERE u.id IN (?1, ?2) AND (u.mutedUntil IS NULL OR u.mutedUntil <= ?3)
         AND EXISTS (SELECT 1 FROM user_sessions WHERE userId = u.id AND expiresAt >= ?4
           AND sessionId = CASE WHEN u.id = ?1 THEN ?5 ELSE ?6 END)`,
    ).bind(caller.userId, callee?.userId ?? null, now, Math.floor(now / 1000), caller.sessionId,
      callee?.sessionId ?? null).all<{ id: string }>()
    return results.length === (callee === undefined ? 1 : 2)
  }

  private getTemporary<T>(key: string, now: number): T | undefined {
    const item = this.kv.get<Temporary<T>>(TEMP + key)
    return item !== undefined && item.expiresAt > now ? item.value : undefined
  }

  private putTemporary<T>(key: string, value: T, expiresAt: number): void {
    this.kv.put(TEMP + key, { value, expiresAt } satisfies Temporary<T>)
    this.alarmDirty = true
  }

  private takeInvite(userId: string, now: number): boolean {
    const key = 'invite:' + userId
    const budget = this.getTemporary<Budget>(key, now) ?? { count: 0, until: now + INVITE_WINDOW_MS }
    if (budget.count >= INVITES_PER_WINDOW) return false
    budget.count += 1
    this.putTemporary(key, budget, budget.until)
    return true
  }

  private take(budgets: WeakMap<WebSocket, Budget>, ws: WebSocket, max: number): boolean {
    const now = Date.now()
    const previous = budgets.get(ws)
    if (previous === undefined || previous.until <= now) {
      budgets.set(ws, { count: 1, until: now + 10_000 })
      return true
    }
    if (previous.count >= max) return false
    previous.count += 1
    return true
  }
}
