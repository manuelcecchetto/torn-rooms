// Who can see, post in and manage a room. Pure functions over a loaded room context.
import type { Role } from '../../shared/protocol';

export interface Viewer {
  id: number;
  factionId: number | null;
  superadmin: boolean;
}

export interface RoomCtx {
  id: string;
  visibility: 'public' | 'private';
  postPolicy: 'everyone' | 'admins';
  ownerId: number;
  admins: Set<number>;
  players: Set<number>;
  factions: Set<number>;
  bans: Set<number>;
  /** membership state per user: 'joined' or 'left' */
  membership: Map<number, 'joined' | 'left'>;
}

export function canSee(room: RoomCtx, v: Viewer): boolean {
  if (room.bans.has(v.id)) return false;
  if (room.visibility === 'public') return true;
  return (
    room.ownerId === v.id ||
    room.admins.has(v.id) ||
    room.players.has(v.id) ||
    (v.factionId !== null && room.factions.has(v.factionId))
  );
}

export function roleOf(room: RoomCtx, v: Viewer): Role {
  if (room.ownerId === v.id) return 'owner';
  if (room.admins.has(v.id)) return 'admin';
  // Superadmins moderate public rooms; private rooms stay private.
  if (v.superadmin && room.visibility === 'public') return 'admin';
  return 'member';
}

export function isJoined(room: RoomCtx, v: Viewer): boolean {
  return room.membership.get(v.id) === 'joined';
}

/** In the viewer's list: joined rooms they can see, plus private rooms shared with them they have not left. */
export function isListed(room: RoomCtx, v: Viewer): boolean {
  if (!canSee(room, v)) return false;
  const state = room.membership.get(v.id);
  if (state === 'joined') return true;
  return room.visibility === 'private' && state === undefined;
}

export function canManage(room: RoomCtx, v: Viewer): boolean {
  return canSee(room, v) && roleOf(room, v) !== 'member';
}

export function canPost(room: RoomCtx, v: Viewer): boolean {
  if (!canSee(room, v) || !isJoined(room, v)) return false;
  return room.postPolicy === 'everyone' || roleOf(room, v) !== 'member';
}

/** Should this viewer receive live messages of the room. */
export function receives(room: RoomCtx, v: Viewer): boolean {
  return canSee(room, v) && isJoined(room, v);
}
