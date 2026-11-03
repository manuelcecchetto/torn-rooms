// One Durable Object holds every room: metadata, access lists, messages and the
// live event streams. Clients stream Server-Sent Events: Torn's CSP blocks
// WebSockets from userscripts, while Tampermonkey's GM_xmlhttpRequest can stream.
// Shard per room later if one object gets hot.
import { DurableObject } from 'cloudflare:workers';
import {
  LIMITS,
  type AccessView,
  type BrowseRoom,
  type GrantKind,
  type MessageView,
  type PollResponse,
  type PostPolicy,
  type RoomView,
  type ServerEvent,
  type Visibility,
} from '../../shared/protocol';
import { canManage, canPost, canSee, isJoined, isListed, receives, roleOf, type RoomCtx, type Viewer } from './access';

export interface Env {
  HUB: DurableObjectNamespace<Hub>;
  TOKEN_SECRET: string;
  TORN_API_BASE: string;
  SUPERADMINS: string;
  ALLOWED_ORIGINS: string;
}

export interface Caller extends Viewer {
  name: string;
  factionTag: string | null;
  avatar: string | null;
  exp: number;
}

export type Res<T> = { status: 200; body: T } | { status: 400 | 403 | 404 | 409 | 429; body: { error: string } };

const ok = <T>(body: T): Res<T> => ({ status: 200, body });
const fail = (status: 400 | 403 | 404 | 409 | 429, error: string): Res<never> => ({ status, body: { error } });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, faction_id INTEGER, faction_tag TEXT, avatar TEXT, show_avatar INTEGER NOT NULL DEFAULT 0, banned INTEGER NOT NULL DEFAULT 0, seen_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, topic TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '', visibility TEXT NOT NULL, post_policy TEXT NOT NULL, show_tags INTEGER NOT NULL DEFAULT 0, owner_id INTEGER NOT NULL, created_at INTEGER NOT NULL, last_msg_id INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS grants(room_id TEXT NOT NULL, kind TEXT NOT NULL, target_id INTEGER NOT NULL, label TEXT NOT NULL, added_by INTEGER NOT NULL, added_at INTEGER NOT NULL, PRIMARY KEY(room_id, kind, target_id));
CREATE TABLE IF NOT EXISTS admins(room_id TEXT NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY(room_id, user_id));
CREATE TABLE IF NOT EXISTS bans(room_id TEXT NOT NULL, user_id INTEGER NOT NULL, label TEXT NOT NULL, banned_by INTEGER NOT NULL, banned_at INTEGER NOT NULL, PRIMARY KEY(room_id, user_id));
CREATE TABLE IF NOT EXISTS memberships(room_id TEXT NOT NULL, user_id INTEGER NOT NULL, state TEXT NOT NULL, last_read INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(room_id, user_id));
CREATE INDEX IF NOT EXISTS memberships_user ON memberships(user_id);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, user_id INTEGER NOT NULL, name TEXT NOT NULL, avatar TEXT, faction_tag TEXT, text TEXT NOT NULL, ts INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS messages_room ON messages(room_id, id);
`;

interface RoomRow {
  id: string;
  name: string;
  description: string;
  topic: string;
  icon: string;
  color: string;
  visibility: Visibility;
  post_policy: PostPolicy;
  show_tags: number;
  owner_id: number;
  created_at: number;
  last_msg_id: number;
}

interface MessageRow {
  id: number;
  room_id: string;
  user_id: number;
  name: string;
  avatar: string | null;
  faction_tag: string | null;
  text: string;
  ts: number;
}

type Row = Record<string, SqlStorageValue>;

function clean(s: unknown, max: number): string {
  return typeof s === 'string' ? s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max) : '';
}

type RoomInput = { name?: unknown; description?: unknown; topic?: unknown; icon?: unknown; color?: unknown; visibility?: unknown; postPolicy?: unknown; showFactionTags?: unknown };

function colorValue(v: unknown): string {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : '';
}

function iconName(v: unknown): string {
  return typeof v === 'string' && /^[a-z0-9_]{1,40}$/i.test(v) ? v : '';
}

function newRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

interface Stream {
  caller: Caller;
  writer: WritableStreamDefaultWriter<Uint8Array>;
}

const encoder = new TextEncoder();
const HEARTBEAT_MS = 20_000;

const toMessage = (r: MessageRow): MessageView => ({ id: r.id, roomId: r.room_id, userId: r.user_id, name: r.name, avatar: r.avatar, factionTag: r.faction_tag, text: r.text, ts: r.ts });

export class Hub extends DurableObject<Env> {
  private sql: SqlStorage;
  private ctxCache = new Map<string, RoomCtx>();
  private limiter = new Map<string, number[]>();
  private limiterCalls = 0;
  private streams = new Set<Stream>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
    // Columns added after a database already existed.
    const roomCols = new Set(this.rows<{ name: string }>("SELECT name FROM pragma_table_info('rooms')").map((c) => c.name));
    if (!roomCols.has('color')) this.sql.exec("ALTER TABLE rooms ADD COLUMN color TEXT NOT NULL DEFAULT ''");
    if (!roomCols.has('show_tags')) this.sql.exec('ALTER TABLE rooms ADD COLUMN show_tags INTEGER NOT NULL DEFAULT 0');
    const msgCols = new Set(this.rows<{ name: string }>("SELECT name FROM pragma_table_info('messages')").map((c) => c.name));
    if (!msgCols.has('faction_tag')) this.sql.exec('ALTER TABLE messages ADD COLUMN faction_tag TEXT');
    const userCols = new Set(this.rows<{ name: string }>("SELECT name FROM pragma_table_info('users')").map((c) => c.name));
    if (!userCols.has('show_avatar')) {
      // Pictures were stored before consent existed: nobody has agreed yet, so drop them.
      this.sql.exec('ALTER TABLE users ADD COLUMN show_avatar INTEGER NOT NULL DEFAULT 0');
      this.sql.exec('UPDATE users SET avatar = NULL');
      this.sql.exec('UPDATE messages SET avatar = NULL');
    }
  }

  private rows<T>(query: string, ...params: SqlStorageValue[]): T[] {
    return this.sql.exec<Row>(query, ...params).toArray() as unknown as T[];
  }

  private roomRow(id: string): RoomRow | undefined {
    return this.rows<RoomRow>('SELECT * FROM rooms WHERE id = ?', id)[0];
  }

  private roomCtx(id: string): RoomCtx | undefined {
    const cached = this.ctxCache.get(id);
    if (cached) return cached;
    const r = this.roomRow(id);
    if (!r) return undefined;
    const ids = (q: string) => new Set(this.rows<{ v: number }>(q, id).map((x) => x.v));
    const ctx: RoomCtx = {
      id,
      visibility: r.visibility,
      postPolicy: r.post_policy,
      ownerId: r.owner_id,
      admins: ids('SELECT user_id AS v FROM admins WHERE room_id = ?'),
      players: ids("SELECT target_id AS v FROM grants WHERE room_id = ? AND kind = 'player'"),
      factions: ids("SELECT target_id AS v FROM grants WHERE room_id = ? AND kind = 'faction'"),
      bans: ids('SELECT user_id AS v FROM bans WHERE room_id = ?'),
      membership: new Map(
        this.rows<{ user_id: number; state: 'joined' | 'left' }>('SELECT user_id, state FROM memberships WHERE room_id = ?', id).map((m) => [
          m.user_id,
          m.state,
        ]),
      ),
    };
    this.ctxCache.set(id, ctx);
    return ctx;
  }

  private viewOf(r: RoomRow, room: RoomCtx, v: Viewer): RoomView {
    // Like history: a private room's messages stay hidden until the invitation is accepted.
    const readable = r.visibility === 'public' || isJoined(room, v);
    const last = readable && r.last_msg_id ? this.rows<MessageRow>('SELECT * FROM messages WHERE id = ? AND deleted = 0', r.last_msg_id)[0] : undefined;
    const read = this.rows<{ last_read: number }>('SELECT last_read FROM memberships WHERE room_id = ? AND user_id = ?', r.id, v.id)[0];
    const lastRead = read ? read.last_read : 0;
    const unread =
      isJoined(room, v) && r.last_msg_id > lastRead
        ? this.rows<{ n: number }>(
            'SELECT COUNT(*) AS n FROM (SELECT 1 FROM messages WHERE room_id = ? AND id > ? AND user_id <> ? AND deleted = 0 LIMIT 100)',
            r.id, lastRead, v.id,
          )[0].n
        : 0;
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      topic: r.topic,
      icon: r.icon,
      color: r.color,
      visibility: r.visibility,
      postPolicy: r.post_policy,
      showFactionTags: r.show_tags === 1,
      ownerId: r.owner_id,
      role: roleOf(room, v),
      joined: isJoined(room, v),
      canPost: canPost(room, v),
      lastMessage: last ? toMessage(last) : null,
      lastReadId: lastRead,
      unread,
    };
  }

  /** Runs a mutation of one room and tells every connected user whose list may have changed. */
  private mutateRoom(id: string, change: () => void): void {
    const before = this.roomCtx(id);
    const sawBefore = new Set<Stream>();
    if (before) for (const s of this.streams) if (isListed(before, s.caller)) sawBefore.add(s);
    change();
    this.ctxCache.delete(id);
    const after = this.roomCtx(id);
    this.emit((s) => sawBefore.has(s) || (after !== undefined && isListed(after, s.caller)), { t: 'rooms_changed' });
  }

  /** Writes an event to every live stream the filter accepts; drops expired and broken streams. */
  private emit(filter: (s: Stream) => boolean, ev: ServerEvent | null): void {
    const now = Date.now();
    const frame = encoder.encode(ev ? `data: ${JSON.stringify(ev)}\n\n` : ': ping\n\n');
    for (const s of this.streams) {
      if (s.caller.exp <= now) {
        this.drop(s, 'event: expired\ndata: {}\n\n');
        continue;
      }
      if (!filter(s)) continue;
      s.writer.write(frame).catch(() => this.drop(s));
    }
  }

  private drop(s: Stream, last?: string): void {
    if (!this.streams.delete(s)) return;
    const close = () => s.writer.close().catch(() => {});
    if (last) s.writer.write(encoder.encode(last)).then(close, close);
    else close();
    if (this.streams.size === 0 && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  // ---------------------------------------------------------------- users

  /**
   * Records a login. The profile picture is kept only with the player's consent; `consent`
   * is given when the player sets it at login, otherwise the saved choice stays.
   */
  async upsertUser(
    u: { id: number; name: string; factionId: number | null; factionTag: string | null; avatar: string | null },
    consent?: boolean,
  ): Promise<{ banned: boolean; showAvatar: boolean }> {
    const prev = this.rows<{ show_avatar: number; banned: number }>('SELECT show_avatar, banned FROM users WHERE id = ?', u.id)[0];
    const show = consent ?? prev?.show_avatar === 1;
    const avatar = show ? u.avatar : null;
    this.sql.exec(
      `INSERT INTO users(id, name, faction_id, faction_tag, avatar, show_avatar, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, faction_id = excluded.faction_id, faction_tag = excluded.faction_tag,
         avatar = excluded.avatar, show_avatar = excluded.show_avatar, seen_at = excluded.seen_at`,
      u.id, u.name, u.factionId, u.factionTag, avatar, show ? 1 : 0, Date.now(),
    );
    this.applyAvatar(u.id, avatar);
    return { banned: prev?.banned === 1, showAvatar: show };
  }

  /** Puts the player's current picture (or none) on all their stored messages. */
  private applyAvatar(userId: number, avatar: string | null): void {
    this.sql.exec('UPDATE messages SET avatar = ? WHERE user_id = ? AND avatar IS NOT ?', avatar, userId, avatar);
  }

  async setAvatarConsent(c: Caller, show: boolean): Promise<Res<{ showAvatar: boolean }>> {
    const avatar = show ? c.avatar : null;
    this.sql.exec('UPDATE users SET show_avatar = ?, avatar = ? WHERE id = ?', show ? 1 : 0, avatar, c.id);
    this.applyAvatar(c.id, avatar);
    return ok({ showAvatar: show });
  }

  async setGlobalBan(c: Caller, userId: number, banned: boolean): Promise<Res<{ ok: true }>> {
    if (!c.superadmin) return fail(403, 'Only site admins can do that');
    this.sql.exec('UPDATE users SET banned = ? WHERE id = ?', banned ? 1 : 0, userId);
    if (banned) for (const s of this.streams) if (s.caller.id === userId) this.drop(s, 'event: banned\ndata: {}\n\n');
    return ok({ ok: true });
  }

  // ---------------------------------------------------------------- rooms

  async listRooms(c: Caller): Promise<Res<{ rooms: RoomView[] }>> {
    // Candidates: rooms with a membership row, owned, administered, or shared with the player or their faction.
    const rows = this.rows<RoomRow>(
      `SELECT * FROM rooms r WHERE
         r.owner_id = ?1
         OR EXISTS (SELECT 1 FROM memberships m WHERE m.room_id = r.id AND m.user_id = ?1)
         OR EXISTS (SELECT 1 FROM admins a WHERE a.room_id = r.id AND a.user_id = ?1)
         OR EXISTS (SELECT 1 FROM grants g WHERE g.room_id = r.id AND g.kind = 'player' AND g.target_id = ?1)
         OR (?2 IS NOT NULL AND EXISTS (SELECT 1 FROM grants g WHERE g.room_id = r.id AND g.kind = 'faction' AND g.target_id = ?2))`,
      c.id, c.factionId,
    );
    const rooms: RoomView[] = [];
    for (const r of rows) {
      const room = this.roomCtx(r.id)!;
      if (isListed(room, c)) rooms.push(this.viewOf(r, room, c));
    }
    return ok({ rooms });
  }

  async browse(c: Caller, search: string): Promise<Res<{ rooms: BrowseRoom[] }>> {
    const q = `%${clean(search, 50).replace(/[%_]/g, '')}%`;
    const rows = this.rows<RoomRow & { members: number }>(
      `SELECT r.*, (SELECT COUNT(*) FROM memberships m WHERE m.room_id = r.id AND m.state = 'joined') AS members
       FROM rooms r WHERE r.visibility = 'public' AND (r.name LIKE ?1 OR r.topic LIKE ?1 OR r.description LIKE ?1)
       ORDER BY members DESC, r.created_at LIMIT 100`,
      q,
    );
    const rooms = rows
      .filter((r) => !this.roomCtx(r.id)!.bans.has(c.id))
      .map((r) => ({ id: r.id, name: r.name, description: r.description, topic: r.topic, icon: r.icon, color: r.color, memberCount: r.members, joined: isJoined(this.roomCtx(r.id)!, c) }));
    return ok({ rooms });
  }

  async createRoom(c: Caller, input: RoomInput): Promise<Res<RoomView>> {
    const name = clean(input.name, LIMITS.roomName);
    if (!name) return fail(400, 'A room needs a name');
    const visibility: Visibility = input.visibility === 'public' ? 'public' : 'private';
    if (visibility === 'public' && !c.superadmin) return fail(403, 'Only site admins can create public rooms');
    const postPolicy: PostPolicy = input.postPolicy === 'admins' ? 'admins' : 'everyone';
    if (!c.superadmin) {
      const owned = this.rows<{ n: number }>('SELECT COUNT(*) AS n FROM rooms WHERE owner_id = ?', c.id)[0].n;
      if (owned >= LIMITS.ownedRooms) return fail(409, `You can own at most ${LIMITS.ownedRooms} rooms`);
    }
    const id = newRoomId();
    this.sql.exec(
      'INSERT INTO rooms(id, name, description, topic, icon, color, visibility, post_policy, show_tags, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, name, clean(input.description, LIMITS.description), clean(input.topic, LIMITS.topic), iconName(input.icon), colorValue(input.color), visibility, postPolicy, input.showFactionTags === true ? 1 : 0, c.id, Date.now(),
    );
    this.sql.exec("INSERT INTO memberships(room_id, user_id, state) VALUES (?, ?, 'joined')", id, c.id);
    this.ctxCache.delete(id);
    this.mutateRoom(id, () => {});
    return ok(this.viewOf(this.roomRow(id)!, this.roomCtx(id)!, c));
  }

  async updateRoom(c: Caller, id: string, input: RoomInput): Promise<Res<RoomView>> {
    const room = this.roomCtx(id);
    if (!room || !canSee(room, c)) return fail(404, 'Room not found');
    if (!canManage(room, c)) return fail(403, 'Only room admins can change settings');
    const r = this.roomRow(id)!;
    const name = input.name === undefined ? r.name : clean(input.name, LIMITS.roomName);
    if (!name) return fail(400, 'A room needs a name');
    const visibility = input.visibility === undefined ? r.visibility : input.visibility === 'public' ? 'public' : 'private';
    if (visibility !== r.visibility && !c.superadmin) return fail(403, 'Only site admins can make rooms public or private');
    const postPolicy = input.postPolicy === undefined ? r.post_policy : input.postPolicy === 'admins' ? 'admins' : 'everyone';
    this.mutateRoom(id, () => {
      this.sql.exec(
        'UPDATE rooms SET name = ?, description = ?, topic = ?, icon = ?, color = ?, visibility = ?, post_policy = ?, show_tags = ? WHERE id = ?',
        name,
        input.description === undefined ? r.description : clean(input.description, LIMITS.description),
        input.topic === undefined ? r.topic : clean(input.topic, LIMITS.topic),
        input.icon === undefined ? r.icon : iconName(input.icon),
        input.color === undefined ? r.color : colorValue(input.color),
        visibility,
        postPolicy,
        input.showFactionTags === undefined ? r.show_tags : input.showFactionTags === true ? 1 : 0,
        id,
      );
    });
    return ok(this.viewOf(this.roomRow(id)!, this.roomCtx(id)!, c));
  }

  async deleteRoom(c: Caller, id: string): Promise<Res<{ ok: true }>> {
    const room = this.roomCtx(id);
    if (!room || !canSee(room, c)) return fail(404, 'Room not found');
    if (room.ownerId !== c.id && !(c.superadmin && room.visibility === 'public')) return fail(403, 'Only the owner can delete a room');
    this.mutateRoom(id, () => {
      for (const t of ['rooms', 'grants', 'admins', 'bans', 'memberships', 'messages']) {
        this.sql.exec(`DELETE FROM ${t} WHERE ${t === 'rooms' ? 'id' : 'room_id'} = ?`, id);
      }
    });
    return ok({ ok: true });
  }

  async join(c: Caller, id: string): Promise<Res<RoomView>> {
    const room = this.roomCtx(id);
    if (!room || !canSee(room, c)) return fail(404, 'Room not found');
    this.mutateRoom(id, () => {
      this.sql.exec(
        `INSERT INTO memberships(room_id, user_id, state) VALUES (?, ?, 'joined') ON CONFLICT(room_id, user_id) DO UPDATE SET state = 'joined'`,
        id, c.id,
      );
    });
    return ok(this.viewOf(this.roomRow(id)!, this.roomCtx(id)!, c));
  }

  async leave(c: Caller, id: string): Promise<Res<{ ok: true }>> {
    const room = this.roomCtx(id);
    if (!room || !canSee(room, c)) return fail(404, 'Room not found');
    if (room.ownerId === c.id) return fail(409, 'The owner cannot leave; delete the room instead');
    this.mutateRoom(id, () => {
      this.sql.exec(
        `INSERT INTO memberships(room_id, user_id, state) VALUES (?, ?, 'left') ON CONFLICT(room_id, user_id) DO UPDATE SET state = 'left'`,
        id, c.id,
      );
    });
    return ok({ ok: true });
  }

  async markRead(c: Caller, id: string, messageId: number): Promise<Res<{ ok: true }>> {
    const room = this.roomCtx(id);
    if (!room || !receives(room, c)) return fail(404, 'Room not found');
    this.sql.exec('UPDATE memberships SET last_read = MAX(last_read, ?) WHERE room_id = ? AND user_id = ?', Math.floor(messageId) || 0, id, c.id);
    return ok({ ok: true });
  }

  // ---------------------------------------------------------------- access

  async access(c: Caller, id: string): Promise<Res<AccessView>> {
    const room = this.roomCtx(id);
    if (!room || !canSee(room, c)) return fail(404, 'Room not found');
    const grants = this.rows<{ kind: GrantKind; target_id: number; label: string; added_by: number; added_at: number }>(
      'SELECT * FROM grants WHERE room_id = ? ORDER BY kind DESC, added_at',
      id,
    ).map((g) => ({ kind: g.kind, id: g.target_id, label: g.label, addedBy: g.added_by, addedAt: g.added_at }));
    const members = this.rows<{ id: number; name: string; faction_id: number | null }>(
      `SELECT u.id, u.name, u.faction_id FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.room_id = ? AND m.state = 'joined' ORDER BY u.name LIMIT 500`,
      id,
    )
      .filter((u) => canSee(room, { id: u.id, factionId: u.faction_id, superadmin: false }))
      .map((u) => ({ id: u.id, name: u.name, role: roleOf(room, { id: u.id, factionId: u.faction_id, superadmin: false }) }));
    const bans = canManage(room, c)
      ? this.rows<{ user_id: number; label: string; banned_at: number }>('SELECT * FROM bans WHERE room_id = ? ORDER BY banned_at DESC', id).map((b) => ({
          id: b.user_id,
          label: b.label,
          bannedAt: b.banned_at,
        }))
      : [];
    return ok({ grants, members, bans });
  }

  async addGrant(c: Caller, id: string, kind: unknown, targetId: unknown, label: unknown): Promise<Res<{ ok: true }>> {
    const room = this.roomCtx(id);
    if (!room || !canSee(room, c)) return fail(404, 'Room not found');
    if (!canManage(room, c)) return fail(403, 'Only room admins can invite');
    if (kind !== 'player' && kind !== 'faction') return fail(400, 'Invite a player or a faction');
    const target = Number(targetId);
    if (!Number.isInteger(target) || target <= 0) return fail(400, 'Invalid ID');
    const count = this.rows<{ n: number }>('SELECT COUNT(*) AS n FROM grants WHERE room_id = ?', id)[0].n;
    if (count >= LIMITS.grantsPerRoom) return fail(409, `A room can have at most ${LIMITS.grantsPerRoom} invites`);
    const known = kind === 'player' ? this.rows<{ name: string }>('SELECT name FROM users WHERE id = ?', target)[0]?.name : undefined;
    const name = clean(label, LIMITS.label) || known || `${kind === 'player' ? 'Player' : 'Faction'} #${target}`;
    this.mutateRoom(id, () => {
      this.sql.exec(
        `INSERT INTO grants(room_id, kind, target_id, label, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(room_id, kind, target_id) DO UPDATE SET label = excluded.label`,
        id, kind, target, name, c.id, Date.now(),
      );
      // A personal invite brings back a player who left, as a fresh invitation.
      if (kind === 'player') this.sql.exec("DELETE FROM memberships WHERE room_id = ? AND user_id = ? AND state = 'left'", id, target);
    });
    return ok({ ok: true });
  }

  async removeGrant(c: Caller, id: string, kind: string, targetId: number): Promise<Res<{ ok: true }>> {
    const room = this.roomCtx(id);
    if (!room || !canSee(room, c)) return fail(404, 'Room not found');
    if (!canManage(room, c)) return fail(403, 'Only room admins can remove invites');
    this.mutateRoom(id, () => {
      this.sql.exec('DELETE FROM grants WHERE room_id = ? AND kind = ? AND target_id = ?', id, kind, targetId);
    });
    return ok({ ok: true });
  }

  async setAdmin(c: Caller, id: string, userId: number, admin: boolean): Promise<Res<{ ok: true }>> {
    const room = this.roomCtx(id);
    if (!room || !canSee(room, c)) return fail(404, 'Room not found');
    if (room.ownerId !== c.id && !(c.superadmin && room.visibility === 'public')) return fail(403, 'Only the owner can change admins');
    if (userId === room.ownerId) return fail(400, 'The owner is already in charge');
    if (admin) {
      if (room.admins.size >= LIMITS.adminsPerRoom) return fail(409, `A room can have at most ${LIMITS.adminsPerRoom} admins`);
      const u = this.rows<{ id: number; faction_id: number | null }>('SELECT id, faction_id FROM users WHERE id = ?', userId)[0];
      if (!u || !canSee(room, { id: u.id, factionId: u.faction_id, superadmin: false })) return fail(400, 'Only people with access to the room can be admins');
    }
    this.mutateRoom(id, () => {
      if (admin) this.sql.exec('INSERT OR IGNORE INTO admins(room_id, user_id) VALUES (?, ?)', id, userId);
      else this.sql.exec('DELETE FROM admins WHERE room_id = ? AND user_id = ?', id, userId);
    });
    return ok({ ok: true });
  }

  async setBan(c: Caller, id: string, userId: number, banned: boolean, label: unknown): Promise<Res<{ ok: true }>> {
    const room = this.roomCtx(id);
    if (!room || !canSee(room, c)) return fail(404, 'Room not found');
    if (!canManage(room, c)) return fail(403, 'Only room admins can ban');
    if (userId === room.ownerId || (room.admins.has(userId) && room.ownerId !== c.id)) return fail(403, 'You cannot ban this person');
    const known = this.rows<{ name: string }>('SELECT name FROM users WHERE id = ?', userId)[0]?.name;
    this.mutateRoom(id, () => {
      if (banned) {
        this.sql.exec(
          'INSERT OR REPLACE INTO bans(room_id, user_id, label, banned_by, banned_at) VALUES (?, ?, ?, ?, ?)',
          id, userId, clean(label, LIMITS.label) || known || `Player #${userId}`, c.id, Date.now(),
        );
        this.sql.exec('DELETE FROM admins WHERE room_id = ? AND user_id = ?', id, userId);
      } else {
        this.sql.exec('DELETE FROM bans WHERE room_id = ? AND user_id = ?', id, userId);
      }
    });
    return ok({ ok: true });
  }

  // ---------------------------------------------------------------- messages

  async history(c: Caller, id: string, before: number): Promise<Res<{ messages: MessageView[] }>> {
    const room = this.roomCtx(id);
    if (!room || !canSee(room, c)) return fail(404, 'Room not found');
    if (room.visibility === 'private' && !isJoined(room, c)) return fail(403, 'Accept the invitation to read this room');
    const rows = this.rows<MessageRow>(
      'SELECT * FROM messages WHERE room_id = ? AND deleted = 0 AND id < ? ORDER BY id DESC LIMIT ?',
      id, before > 0 ? before : Number.MAX_SAFE_INTEGER, LIMITS.historyPage,
    );
    return ok({ messages: rows.reverse().map(toMessage) });
  }

  async post(c: Caller, id: string, text: unknown): Promise<Res<MessageView>> {
    const room = this.roomCtx(id);
    if (!room || !canSee(room, c)) return fail(404, 'Room not found');
    if (!isJoined(room, c)) return fail(403, 'Join the room first');
    if (!canPost(room, c)) return fail(403, 'Only admins can post in this room');
    const body = typeof text === 'string' ? text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim() : '';
    if (!body) return fail(400, 'Empty message');
    if (body.length > LIMITS.message) return fail(400, `Messages are at most ${LIMITS.message} characters`);
    const now = Date.now();
    if (!this.allow(`msg:${c.id}`, LIMITS.rateCount, LIMITS.rateWindowMs)) return fail(429, 'Slow down');

    const row = this.rows<MessageRow>(
      'INSERT INTO messages(room_id, user_id, name, avatar, faction_tag, text, ts) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *',
      id, c.id, c.name, this.rows<{ avatar: string | null }>('SELECT avatar FROM users WHERE id = ?', c.id)[0]?.avatar ?? null, c.factionTag, body, now,
    )[0];
    this.sql.exec('UPDATE rooms SET last_msg_id = ? WHERE id = ?', row.id, id);
    this.sql.exec('UPDATE memberships SET last_read = ? WHERE room_id = ? AND user_id = ?', row.id, id, c.id);
    if (row.id % 100 === 0) {
      this.sql.exec(
        'DELETE FROM messages WHERE room_id = ? AND id <= (SELECT id FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)',
        id, id, LIMITS.keptMessagesPerRoom,
      );
    }
    const msg = toMessage(row);
    this.emit((s) => receives(room, s.caller), { t: 'msg', msg });
    return ok(msg);
  }

  async deleteMessage(c: Caller, id: string, messageId: number): Promise<Res<{ ok: true }>> {
    const room = this.roomCtx(id);
    if (!room || !canSee(room, c)) return fail(404, 'Room not found');
    const m = this.rows<MessageRow>('SELECT * FROM messages WHERE id = ? AND room_id = ? AND deleted = 0', messageId, id)[0];
    if (!m) return fail(404, 'Message not found');
    if (m.user_id !== c.id && !canManage(room, c)) return fail(403, 'You can only delete your own messages');
    this.sql.exec('UPDATE messages SET deleted = 1 WHERE id = ?', messageId);
    this.emit((s) => receives(room, s.caller), { t: 'msg_deleted', roomId: id, id: messageId });
    return ok({ ok: true });
  }

  // ---------------------------------------------------------------- HTTP API

  /**
   * Every authenticated request except the event stream: the Worker verified the token, this checks
   * the global ban and the abuse limits in one place, then dispatches.
   */
  async api(c: Caller, m: string, path: string, query: Record<string, string>, body: Record<string, unknown>): Promise<Res<unknown>> {
    const p = path.split('/').filter(Boolean); // ['v1', 'rooms', id, ...]
    if (p[0] !== 'v1') return fail(404, 'Not found');
    if (this.isBanned(c.id)) return fail(403, 'You are banned from Torn Rooms');
    if (m === 'GET' && !this.allow(`read:${c.id}`, LIMITS.readsPerMinute, 60_000)) return fail(429, 'Slow down');
    if (p[1] === 'poll' && p.length === 2 && m === 'GET') return this.poll(c, query.open ?? '', query.after);
    if (m !== 'GET') {
      if (!this.allow(`write:${c.id}`, LIMITS.writesPerMinute, 60_000)) return fail(429, 'Slow down');
      if (p[3] === 'grants' && m === 'POST' && !this.allow(`invite:${c.id}`, LIMITS.invitesPerHour, 3_600_000)) {
        return fail(429, `You can send at most ${LIMITS.invitesPerHour} invites an hour`);
      }
    }


    if (p[1] === 'me' && p.length === 2 && m === 'PATCH') return this.setAvatarConsent(c, body.showAvatar === true);
    if (p[1] === 'rooms') {
      if (p.length === 2 && m === 'GET') return this.listRooms(c);
      if (p.length === 2 && m === 'POST') return this.createRoom(c, body);
      if (p.length === 3 && p[2] === 'browse' && m === 'GET') return this.browse(c, query.q ?? '');
      const id = p[2];
      if (p.length === 3 && m === 'PATCH') return this.updateRoom(c, id, body);
      if (p.length === 3 && m === 'DELETE') return this.deleteRoom(c, id);
      if (p.length === 4) {
        if (p[3] === 'join' && m === 'POST') return this.join(c, id);
        if (p[3] === 'leave' && m === 'POST') return this.leave(c, id);
        if (p[3] === 'read' && m === 'POST') return this.markRead(c, id, Number(body.id));
        if (p[3] === 'access' && m === 'GET') return this.access(c, id);
        if (p[3] === 'messages' && m === 'GET') return this.history(c, id, Number(query.before ?? 0));
        if (p[3] === 'messages' && m === 'POST') return this.post(c, id, body.text);
        if (p[3] === 'grants' && m === 'POST') return this.addGrant(c, id, body.kind, body.id, body.label);
      }
      if (p.length === 5 && p[3] === 'messages' && m === 'DELETE') return this.deleteMessage(c, id, Number(p[4]));
      if (p.length === 5 && p[3] === 'admins') {
        if (m === 'POST') return this.setAdmin(c, id, Number(p[4]), true);
        if (m === 'DELETE') return this.setAdmin(c, id, Number(p[4]), false);
      }
      if (p.length === 5 && p[3] === 'bans') {
        if (m === 'POST') return this.setBan(c, id, Number(p[4]), true, body.label);
        if (m === 'DELETE') return this.setBan(c, id, Number(p[4]), false, undefined);
      }
      if (p.length === 6 && p[3] === 'grants' && m === 'DELETE') return this.removeGrant(c, id, p[4], Number(p[5]));
    }
    if (p[1] === 'admin' && p[2] === 'bans' && p.length === 4) {
      if (m === 'POST') return this.setGlobalBan(c, Number(p[3]), true);
      if (m === 'DELETE') return this.setGlobalBan(c, Number(p[3]), false);
    }
    return fail(404, 'Not found');
  }

  /** The room list and the latest history of the rooms the client has open (`open` = comma-separated ids). */
  private async snapshot(c: Caller, open: string): Promise<{ rooms: RoomView[]; history: Record<string, MessageView[]> }> {
    const history: Record<string, MessageView[]> = {};
    for (const id of open.split(',').filter(Boolean).slice(0, LIMITS.helloRooms)) {
      const res = await this.history(c, id, 0);
      if (res.status === 200) history[id] = res.body.messages;
    }
    const rooms = await this.listRooms(c);
    return { rooms: rooms.status === 200 ? rooms.body.rooms : [], history };
  }

  /** The stream as a request: see PollResponse. */
  private async poll(c: Caller, open: string, after: string | undefined): Promise<Res<PollResponse>> {
    const cursor = this.rows<{ n: number }>('SELECT COALESCE(MAX(id), 0) AS n FROM messages')[0].n;
    const since = Number(after);
    if (after === undefined || !Number.isInteger(since) || since < 0) return ok({ ...(await this.snapshot(c, open)), messages: [], cursor });
    const { rooms } = await this.snapshot(c, '');
    const messages = this.rows<MessageRow>('SELECT * FROM messages WHERE id > ? AND id <= ? AND deleted = 0 ORDER BY id LIMIT 500', since, cursor)
      .filter((r) => {
        const room = this.roomCtx(r.room_id);
        return room !== undefined && receives(room, c);
      })
      .map(toMessage);
    return ok({ rooms, history: {}, messages, cursor });
  }

  /** Logins per client IP: each one costs two Torn API calls. */
  async allowLogin(ip: string): Promise<boolean> {
    return this.allow(`login:${ip}`, LIMITS.loginsPerIp, LIMITS.loginWindowMs);
  }

  private isBanned(userId: number): boolean {
    return this.rows<{ banned: number }>('SELECT banned FROM users WHERE id = ?', userId)[0]?.banned === 1;
  }

  /** Sliding-window limiter in memory (one object serves everyone, so it is global; it resets if the object restarts). */
  private allow(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    if (++this.limiterCalls % 1000 === 0) {
      for (const [k, ts] of this.limiter) if (now - ts[ts.length - 1] > 3_600_000) this.limiter.delete(k);
    }
    const recent = (this.limiter.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      this.limiter.set(key, recent);
      return false;
    }
    recent.push(now);
    this.limiter.set(key, recent);
    return true;
  }

  // ---------------------------------------------------------------- event stream

  async fetch(request: Request): Promise<Response> {
    // Only the Worker calls this, after verifying the token; it passes the caller in a header.
    const caller = JSON.parse(request.headers.get('x-caller') ?? 'null') as Caller | null;
    if (!caller) return new Response('missing caller', { status: 400 });
    if (this.isBanned(caller.id)) return new Response('banned', { status: 403 });
    // One request per Torn page load: the hello event replaces separate room-list and history calls.
    const hello: ServerEvent = { t: 'hello', ...(await this.snapshot(caller, new URL(request.url).searchParams.get('open') ?? '')) };
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const stream: Stream = { caller, writer: writable.getWriter() };
    // A player has a few Torn tabs open at most; past that, the oldest stream goes.
    const mine = [...this.streams].filter((s) => s.caller.id === caller.id);
    for (const s of mine.slice(0, Math.max(0, mine.length - LIMITS.streamsPerUser + 1))) this.drop(s, 'event: replaced\ndata: {}\n\n');
    this.streams.add(stream);
    stream.writer.write(encoder.encode(`retry: 3000\ndata: ${JSON.stringify(hello)}\n\n`)).catch(() => this.drop(stream));
    if (!this.heartbeat) this.heartbeat = setInterval(() => this.emit(() => true, null), HEARTBEAT_MS);
    return new Response(readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' },
    });
  }
}
