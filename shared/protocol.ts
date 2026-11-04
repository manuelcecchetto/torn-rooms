// Wire types shared by the Worker and the userscript.

export type Visibility = 'public' | 'private';
export type PostPolicy = 'everyone' | 'admins';
export type Role = 'owner' | 'admin' | 'member';
export type GrantKind = 'player' | 'faction';

export interface Me {
  id: number;
  name: string;
  factionId: number | null;
  factionTag: string | null;
  avatar: string | null;
  /** The player agreed to show their Torn profile picture next to their messages (off by default). */
  showAvatar: boolean;
  superadmin: boolean;
}

export interface MessageView {
  id: number;
  roomId: string;
  userId: number;
  name: string;
  avatar: string | null;
  /** The sender's faction tag when they posted; shown only in rooms with showFactionTags. */
  factionTag: string | null;
  text: string;
  ts: number;
}

export interface RoomView {
  id: string;
  name: string;
  description: string;
  topic: string;
  /** Name of one of Torn's room icons; empty for the default chat icon. */
  icon: string;
  /** Header and bar button color, `#rrggbb`; empty for Torn's default grey. */
  color: string;
  visibility: Visibility;
  postPolicy: PostPolicy;
  /** Senders appear as `[TAG] Name` (set by the room's owner or admins). */
  showFactionTags: boolean;
  ownerId: number;
  role: Role;
  /** false: the room was shared with you (player or faction) and you have not opened it yet. */
  joined: boolean;
  canPost: boolean;
  lastMessage: MessageView | null;
  lastReadId: number;
  /** Messages from others after lastReadId, capped at 100. */
  unread: number;
}

export interface BrowseRoom {
  id: string;
  name: string;
  description: string;
  topic: string;
  icon: string;
  color: string;
  memberCount: number;
  joined: boolean;
}

export interface GrantView {
  kind: GrantKind;
  id: number;
  label: string;
  addedBy: number;
  addedAt: number;
}

export interface MemberView {
  id: number;
  name: string;
  role: Role;
}

export interface BanView {
  id: number;
  label: string;
  bannedAt: number;
}

export interface AccessView {
  grants: GrantView[];
  members: MemberView[];
  bans: BanView[];
}

export interface AuthResponse {
  token: string;
  exp: number;
  me: Me;
}

/**
 * GET /v1/poll, for clients that cannot read a stream (Torn PDA returns a response only once it is
 * complete). Without `after` it is the hello snapshot; with it, the room list plus the messages after
 * that cursor that the stream would have delivered. Pass `cursor` as `after` next time.
 */
export interface PollResponse {
  rooms: RoomView[];
  history: Record<string, MessageView[]>;
  messages: MessageView[];
  cursor: number;
  /** who is typing in the rooms the client receives, by room */
  typing: Record<string, TypingUser[]>;
}

/** Someone typing in a room; `ms` is how long to keep showing them unless they ping again. */
export interface TypingUser {
  userId: number;
  name: string;
  ms: number;
}

export type ServerEvent =
  /** First event of every stream: the room list and the latest history of the rooms the client has open. */
  | { t: 'hello'; rooms: RoomView[]; history: Record<string, MessageView[]> }
  | { t: 'msg'; msg: MessageView }
  | { t: 'msg_deleted'; roomId: string; id: number }
  /** everyone typing in the room now */
  | { t: 'typing'; roomId: string; users: TypingUser[] }
  | { t: 'rooms_changed' };

export const LIMITS = {
  roomName: 50,
  description: 200,
  topic: 30,
  message: 2000,
  label: 60,
  ownedRooms: 10,
  grantsPerRoom: 200,
  adminsPerRoom: 20,
  historyPage: 50,
  /** rooms whose history the stream's hello event carries */
  helloRooms: 10,
  keptMessagesPerRoom: 5000,
  /** messages per window per user */
  rateCount: 5,
  rateWindowMs: 5000,
  /** any change (post, invite, join, settings) per user per minute */
  writesPerMinute: 60,
  invitesPerHour: 50,
  /** reads (polls, history, lists) per user per minute; a polling client uses ~15 */
  readsPerMinute: 120,
  /** poll intervals: a room panel open, only the bar or the list (none in the background) */
  pollMs: 4000,
  pollIdleMs: 15000,
  /** typing: a ping at most every typingPingMs while typing, shown for typingMs after the last one */
  typingPingMs: 3000,
  typingMs: 6000,
  typingPerMinute: 30,
  /** event streams per user: a few Torn tabs */
  streamsPerUser: 5,
  loginsPerIp: 20,
  loginWindowMs: 10 * 60 * 1000,
  tokenTtlMs: 6 * 60 * 60 * 1000,
} as const;
