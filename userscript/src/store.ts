// Client state: who we are, our rooms, loaded messages, which panels are open.
import { LIMITS, type Me, type MessageView, type RoomView, type ServerEvent } from '../../shared/protocol';
import { api, type ConnState } from './api';

export type DirectoryTab = 'rooms' | 'invites' | 'browse' | 'settings';

/** Panel key of the Rooms (directory) panel; room panels use their room id. */
export const DIRECTORY = 'directory';

export const state = {
  me: null as Me | null,
  rooms: new Map<string, RoomView>(),
  messages: new Map<string, MessageView[]>(),
  /** older history may exist */
  more: new Map<string, boolean>(),
  /** rooms with a button in the chat bar, in bar order */
  open: GM_getValue<string[]>('open', []),
  /** open rooms whose panel is expanded */
  expanded: new Set(GM_getValue<string[]>('expanded', [])),
  directory: GM_getValue<boolean>('directory', false),
  /** panel keys, rightmost first; a newly opened panel goes to the front, like Torn's */
  order: GM_getValue<string[]>('order', []),
  directoryTab: 'rooms' as DirectoryTab,
  conn: 'connecting' as ConnState,
  /** the first hello event arrived */
  ready: false,
  error: null as string | null,
};

type Listener = () => void;
const listeners = new Set<Listener>();
const messageListeners = new Set<(roomId: string, msg: MessageView | null) => void>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Room panels listen here to append or remove single messages without re-rendering. */
export function onRoomMessage(fn: (roomId: string, msg: MessageView | null) => void): () => void {
  messageListeners.add(fn);
  return () => messageListeners.delete(fn);
}

let scheduled = false;
export function changed(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    for (const fn of listeners) fn();
  });
}

function persist(): void {
  GM_setValue('order', state.order);
  GM_setValue('open', state.open);
  GM_setValue('expanded', [...state.expanded]);
  GM_setValue('directory', state.directory);
}

/** After a consent change: show or hide our own picture on messages already loaded. */
export function setOwnAvatar(show: boolean): void {
  const me = state.me;
  if (!me) return;
  me.showAvatar = show;
  const avatar = show ? me.avatar : null;
  for (const [roomId, list] of state.messages) {
    let touched = false;
    for (const m of list)
      if (m.userId === me.id) {
        m.avatar = avatar;
        touched = true;
      }
    if (touched) for (const fn of messageListeners) fn(roomId, null);
  }
  changed();
}

export function setError(message: string | null): void {
  state.error = message;
  changed();
}

// ---------------------------------------------------------------- rooms

export async function refreshRooms(): Promise<void> {
  const { rooms } = await api<{ rooms: RoomView[] }>('GET', '/v1/rooms');
  setRooms(rooms);
}

function setRooms(rooms: RoomView[]): void {
  state.rooms = new Map(rooms.map((r) => [r.id, r]));
  // Drop bar buttons for rooms we lost access to.
  const before = state.open.length;
  state.open = state.open.filter((id) => state.rooms.get(id)?.joined);
  for (const id of state.expanded) if (!state.open.includes(id)) state.expanded.delete(id);
  if (state.open.length !== before) persist();
  changed();
}

export function joinedRooms(): RoomView[] {
  return [...state.rooms.values()].filter((r) => r.joined).sort((a, b) => (b.lastMessage?.id ?? 0) - (a.lastMessage?.id ?? 0));
}

export function invites(): RoomView[] {
  return [...state.rooms.values()].filter((r) => !r.joined);
}

function toFront(key: string): void {
  state.order = [key, ...state.order.filter((k) => k !== key)];
}

/** Keys of the visible panels, rightmost first. */
export function visiblePanels(): string[] {
  const keys = [...(state.directory ? [DIRECTORY] : []), ...state.open.filter((id) => state.expanded.has(id) && state.rooms.has(id))];
  // Keys missing from the saved order (state from before ordering existed) go to the left end.
  const rank = (k: string) => {
    const i = state.order.indexOf(k);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return keys.sort((a, b) => rank(a) - rank(b));
}

function arrayMove<T>(list: T[], item: T, target: T): T[] {
  const from = list.indexOf(item);
  const to = list.indexOf(target);
  if (from < 0 || to < 0 || from === to) return list;
  const next = [...list];
  next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** Panels that no longer fit on screen: rooms go back to their bar button, the Rooms panel closes. */
export function minimizePanels(keys: string[]): void {
  for (const k of keys) {
    if (k === DIRECTORY) state.directory = false;
    else state.expanded.delete(k);
  }
  persist();
  changed();
}

/** Drop a dragged panel onto another panel's slot. */
export function movePanel(key: string, target: string): void {
  const visible = arrayMove(visiblePanels(), key, target);
  state.order = [...visible, ...state.order.filter((k) => !visible.includes(k))];
  persist();
  changed();
}

/** Drop a dragged chat-bar button onto another button's slot. */
export function moveBarButton(id: string, target: string): void {
  state.open = arrayMove(state.open, id, target);
  persist();
  changed();
}

export function openRoom(id: string): void {
  if (!state.open.includes(id)) state.open.push(id);
  if (!state.expanded.has(id)) toFront(id);
  state.expanded.add(id);
  persist();
  changed();
}

export function toggleRoom(id: string): void {
  if (state.expanded.has(id)) state.expanded.delete(id);
  else {
    state.expanded.add(id);
    toFront(id);
  }
  persist();
  changed();
}

export function closeRoom(id: string): void {
  state.open = state.open.filter((x) => x !== id);
  state.expanded.delete(id);
  persist();
  changed();
}

export function toggleDirectory(open = !state.directory): void {
  if (open && !state.directory) toFront(DIRECTORY);
  state.directory = open;
  persist();
  changed();
}

export function setDirectoryTab(tab: DirectoryTab): void {
  state.directoryTab = tab;
  changed();
}

export async function join(id: string): Promise<void> {
  const room = await api<RoomView>('POST', `/v1/rooms/${id}/join`);
  state.rooms.set(id, room);
  openRoom(id);
}

export async function leave(id: string): Promise<void> {
  await api('POST', `/v1/rooms/${id}/leave`);
  closeRoom(id);
  state.rooms.delete(id);
  state.messages.delete(id);
  changed();
}

export async function deleteRoom(id: string): Promise<void> {
  await api('DELETE', `/v1/rooms/${id}`);
  closeRoom(id);
  state.rooms.delete(id);
  changed();
}

// ---------------------------------------------------------------- messages

export async function loadHistory(id: string, older = false): Promise<void> {
  const list = state.messages.get(id) ?? [];
  const before = older && list.length ? list[0].id : 0;
  const { messages } = await api<{ messages: MessageView[] }>('GET', `/v1/rooms/${id}/messages${before ? `?before=${before}` : ''}`);
  const merged = new Map((older ? [...messages, ...list] : [...list, ...messages]).map((m) => [m.id, m]));
  state.messages.set(id, [...merged.values()].sort((a, b) => a.id - b.id));
  state.more.set(id, messages.length === LIMITS.historyPage);
  changed();
}

export async function send(id: string, text: string): Promise<void> {
  const msg = await api<MessageView>('POST', `/v1/rooms/${id}/messages`, { text });
  addMessage(msg);
  markRead(id);
}

/** The sender as shown in a room: `[TAG] Name` when the room shows faction tags. */
export function senderName(room: RoomView | undefined, m: MessageView): string {
  return room?.showFactionTags && m.factionTag ? `[${m.factionTag}] ${m.name}` : m.name;
}

let readTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Marks everything loaded in the room as read (debounced). */
export function markRead(id: string): void {
  const room = state.rooms.get(id);
  const last = room?.lastMessage?.id ?? 0;
  if (!room || !room.joined || (room.unread === 0 && room.lastReadId >= last)) return;
  room.unread = 0;
  room.lastReadId = last;
  changed();
  clearTimeout(readTimers.get(id));
  readTimers.set(
    id,
    setTimeout(() => api('POST', `/v1/rooms/${id}/read`, { id: last }).catch(() => {}), 500),
  );
}

function addMessage(msg: MessageView): void {
  const list = state.messages.get(msg.roomId);
  if (list && !list.some((m) => m.id === msg.id)) {
    list.push(msg);
    for (const fn of messageListeners) fn(msg.roomId, msg);
  }
  const room = state.rooms.get(msg.roomId);
  if (room && (!room.lastMessage || room.lastMessage.id < msg.id)) {
    room.lastMessage = msg;
    if (msg.userId !== state.me?.id) room.unread += 1;
    else room.lastReadId = msg.id;
  }
  changed();
}

export function handleEvent(ev: ServerEvent): void {
  if (ev.t === 'hello') {
    for (const [id, messages] of Object.entries(ev.history)) {
      state.messages.set(id, messages);
      state.more.set(id, messages.length === LIMITS.historyPage);
      for (const fn of messageListeners) fn(id, null);
    }
    state.ready = true;
    setRooms(ev.rooms);
  } else if (ev.t === 'msg') {
    addMessage(ev.msg);
    // A message in a room we have joined but not opened in this tab: show its button, like Torn does.
    if (!state.open.includes(ev.msg.roomId) && state.rooms.get(ev.msg.roomId)?.joined) {
      state.open.push(ev.msg.roomId);
      persist();
    }
  } else if (ev.t === 'msg_deleted') {
    const list = state.messages.get(ev.roomId);
    if (list) state.messages.set(ev.roomId, list.filter((m) => m.id !== ev.id));
    for (const fn of messageListeners) fn(ev.roomId, null);
    changed();
  } else if (ev.t === 'rooms_changed') {
    refreshRooms().catch(() => {});
  }
}
