import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { LIMITS, type AccessView, type AuthResponse, type BrowseRoom, type MessageView, type PollResponse, type RoomView, type ServerEvent } from '../../shared/protocol';
import { stubIdentity } from './torn-stub';

const BASE = 'https://rooms.test';

async function raw(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(BASE + path, init));
}

async function call<T = any>(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await raw(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function login(uid: number, fid = 0): Promise<string> {
  const res = await raw('/v1/auth', { method: 'POST', body: JSON.stringify({ key: stubIdentity(uid, fid), pageUserId: uid }) });
  expect(res.status).toBe(200);
  return ((await res.json()) as AuthResponse).token;
}

async function stream(token: string, open: string[] = []): Promise<{ events: ServerEvent[]; close: () => Promise<void> }> {
  const res = await raw(`/v1/events?open=${open.join(',')}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  expect(res.headers.get('Content-Type')).toBe('text/event-stream');
  const reader = res.body!.getReader();
  const events: ServerEvent[] = [];
  const dec = new TextDecoder();
  let buf = '';
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = frame.split('\n').find((l) => l.startsWith('data: '));
        if (data) events.push(JSON.parse(data.slice(6)));
      }
    }
  })().catch(() => {});
  return {
    events,
    close: async () => {
      await reader.cancel();
      await pump;
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

async function createRoom(token: string, extra: Record<string, unknown> = {}): Promise<RoomView> {
  const res = await call<RoomView>(token, 'POST', '/v1/rooms', { name: 'War room', description: 'Plans', ...extra });
  expect(res.status).toBe(200);
  return res.body;
}

describe('auth', () => {
  it('rejects a bad key and accepts a good one', async () => {
    const bad = await raw('/v1/auth', { method: 'POST', body: JSON.stringify({ key: 'badkeybadkeybad1', pageUserId: 42 }) });
    expect(bad.status).toBe(401);
    const res = await raw('/v1/auth', { method: 'POST', body: JSON.stringify({ key: stubIdentity(42, 7), pageUserId: 42 }) });
    const body = (await res.json()) as AuthResponse;
    expect(body.me).toEqual({ id: 42, name: 'Player42', factionId: 7, factionTag: 'F7', avatar: 'https://avatars.torn.test/42.png', showAvatar: false, superadmin: false });
  });

  it("refuses another player's key, and logins that do not say who is logged in to Torn", async () => {
    const other = await raw('/v1/auth', { method: 'POST', body: JSON.stringify({ key: stubIdentity(42, 7), pageUserId: 43 }) });
    expect(other.status).toBe(403);
    expect(((await other.json()) as { error: string }).error).toContain('belongs to Player42 [42], not you');
    const anonymous = await raw('/v1/auth', { method: 'POST', body: JSON.stringify({ key: stubIdentity(42, 7) }) });
    expect(anonymous.status).toBe(400);
  });

  it('marks superadmins and refuses requests without a valid token', async () => {
    const res = await raw('/v1/auth', { method: 'POST', body: JSON.stringify({ key: stubIdentity(1, 0), pageUserId: 1 }) });
    expect(((await res.json()) as AuthResponse).me.superadmin).toBe(true);
    expect((await call('nope.nope', 'GET', '/v1/rooms')).status).toBe(401);
    const token = await login(42, 7);
    const forged = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    expect((await call(forged, 'GET', '/v1/rooms')).status).toBe(401);
  });

  it('answers CORS only for allowed origins', async () => {
    const torn = await raw('/v1/rooms', { method: 'OPTIONS', headers: { Origin: 'https://www.torn.com' } });
    expect(torn.headers.get('Access-Control-Allow-Origin')).toBe('https://www.torn.com');
    const other = await raw('/v1/rooms', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    expect(other.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('abuse limits', () => {
  it('refuses players in federal jail', async () => {
    const res = await raw('/v1/auth', { method: 'POST', body: JSON.stringify({ key: stubIdentity(666, 0), pageUserId: 666 }) });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/federal jail/);
  });

  it('limits logins per IP', async () => {
    const attempt = () =>
      raw('/v1/auth', { method: 'POST', headers: { 'CF-Connecting-IP': '203.0.113.9' }, body: JSON.stringify({ key: stubIdentity(4200, 0), pageUserId: 4200 }) });
    for (let i = 0; i < LIMITS.loginsPerIp; i++) expect((await attempt()).status).toBe(200);
    expect((await attempt()).status).toBe(429);
  });

  it('a global ban ends live sessions, not just the next login', async () => {
    const admin = await login(1);
    const spammer = await login(4300);
    const room = await createRoom(spammer, { name: 'Spam' });
    expect((await call(admin, 'POST', '/v1/admin/bans/4300')).status).toBe(200);
    expect((await call(spammer, 'POST', `/v1/rooms/${room.id}/messages`, { text: 'buy xanax' })).status).toBe(403);
    expect((await call(spammer, 'GET', '/v1/rooms')).status).toBe(403);
    expect((await call(admin, 'DELETE', '/v1/admin/bans/4300')).status).toBe(200);
  });

  it('caps invites per hour', async () => {
    const owner = await login(4400);
    const room = await createRoom(owner, { name: 'Invites' });
    for (let i = 0; i < LIMITS.invitesPerHour; i++) {
      expect((await call(owner, 'POST', `/v1/rooms/${room.id}/grants`, { kind: 'player', id: 100000 + i, label: `P${i}` })).status).toBe(200);
    }
    expect((await call(owner, 'POST', `/v1/rooms/${room.id}/grants`, { kind: 'player', id: 99999, label: 'one more' })).status).toBe(429);
  });

  it('refuses the token in the URL', async () => {
    const token = await login(4500);
    expect((await raw(`/v1/rooms?token=${encodeURIComponent(token)}`)).status).toBe(401);
  });
});

describe('profile pictures', () => {
  it('are shown only with consent, and revoking removes them from past messages', async () => {
    const owner = await login(50, 0);
    const room = await createRoom(owner);
    const first = await call<MessageView>(owner, 'POST', `/v1/rooms/${room.id}/messages`, { text: 'no consent yet' });
    expect(first.body.avatar).toBeNull();

    expect((await call(owner, 'PATCH', '/v1/me', { showAvatar: true })).body).toEqual({ showAvatar: true });
    const second = await call<MessageView>(owner, 'POST', `/v1/rooms/${room.id}/messages`, { text: 'with consent' });
    expect(second.body.avatar).toBe('https://avatars.torn.test/50.png');
    let history = (await call<{ messages: MessageView[] }>(owner, 'GET', `/v1/rooms/${room.id}/messages`)).body.messages;
    expect(history.map((m) => m.avatar)).toEqual(['https://avatars.torn.test/50.png', 'https://avatars.torn.test/50.png']);

    // A later login without a choice keeps the saved consent.
    const again = await raw('/v1/auth', { method: 'POST', body: JSON.stringify({ key: stubIdentity(50, 0), pageUserId: 50 }) });
    expect(((await again.json()) as AuthResponse).me.showAvatar).toBe(true);

    await call(owner, 'PATCH', '/v1/me', { showAvatar: false });
    history = (await call<{ messages: MessageView[] }>(owner, 'GET', `/v1/rooms/${room.id}/messages`)).body.messages;
    expect(history.map((m) => m.avatar)).toEqual([null, null]);
  });

  it('can be agreed to at login', async () => {
    const res = await raw('/v1/auth', { method: 'POST', body: JSON.stringify({ key: stubIdentity(51, 0), pageUserId: 51, showAvatar: true }) });
    expect(((await res.json()) as AuthResponse).me.showAvatar).toBe(true);
  });
});

describe('private rooms', () => {
  it('shares a room with a whole faction, and access ends when someone leaves it', async () => {
    const owner = await login(10, 100);
    const ally = await login(20, 200);
    const stranger = await login(30, 300);
    const room = await createRoom(owner);
    expect(room).toMatchObject({ role: 'owner', joined: true, visibility: 'private' });

    expect((await call<{ rooms: RoomView[] }>(ally, 'GET', '/v1/rooms')).body.rooms).toEqual([]);
    expect((await call(owner, 'POST', `/v1/rooms/${room.id}/grants`, { kind: 'faction', id: 200, label: 'Allies' })).status).toBe(200);

    const invited = (await call<{ rooms: RoomView[] }>(ally, 'GET', '/v1/rooms')).body.rooms;
    expect(invited).toHaveLength(1);
    expect(invited[0]).toMatchObject({ id: room.id, joined: false, canPost: false });
    expect((await call(ally, 'GET', `/v1/rooms/${room.id}/messages`)).status).toBe(403);
    expect((await call(ally, 'POST', `/v1/rooms/${room.id}/messages`, { text: 'hi' })).status).toBe(403);

    await call(owner, 'POST', `/v1/rooms/${room.id}/messages`, { text: 'owner only so far' });
    const preview = (await call<{ rooms: RoomView[] }>(ally, 'GET', '/v1/rooms')).body.rooms[0];
    expect(preview).toMatchObject({ lastMessage: null, unread: 0 });
    expect((await call(ally, 'POST', `/v1/rooms/${room.id}/join`)).body).toMatchObject({ joined: true, canPost: true });
    expect((await call(ally, 'POST', `/v1/rooms/${room.id}/messages`, { text: 'hello from allies' })).status).toBe(200);
    const ownerList = await call<{ rooms: RoomView[] }>(owner, 'GET', '/v1/rooms');
    expect(ownerList.body.rooms[0].unread).toBe(1);
    await call(owner, 'POST', `/v1/rooms/${room.id}/read`, { id: ownerList.body.rooms[0].lastMessage!.id });
    expect((await call<{ rooms: RoomView[] }>(owner, 'GET', '/v1/rooms')).body.rooms[0].unread).toBe(0);
    const history = await call<{ messages: MessageView[] }>(owner, 'GET', `/v1/rooms/${room.id}/messages`);
    expect(history.body.messages.map((m) => [m.name, m.text])).toEqual([
      ['Player10', 'owner only so far'],
      ['Player20', 'hello from allies'],
    ]);

    expect((await call(stranger, 'GET', `/v1/rooms/${room.id}/messages`)).status).toBe(404);
    expect((await call(stranger, 'POST', `/v1/rooms/${room.id}/join`)).status).toBe(404);

    // Player 20 moves to faction 300: next login has no access.
    const moved = await login(20, 300);
    expect((await call<{ rooms: RoomView[] }>(moved, 'GET', '/v1/rooms')).body.rooms).toEqual([]);
    expect((await call(moved, 'POST', `/v1/rooms/${room.id}/messages`, { text: 'still here?' })).status).toBe(404);
  });

  it('invites single players, and removing the invite removes access', async () => {
    const owner = await login(11, 0);
    const friend = await login(21, 0);
    const room = await createRoom(owner);
    await call(owner, 'POST', `/v1/rooms/${room.id}/grants`, { kind: 'player', id: 21 });
    const access = await call<AccessView>(owner, 'GET', `/v1/rooms/${room.id}/access`);
    expect(access.body.grants).toEqual([expect.objectContaining({ kind: 'player', id: 21, label: 'Player21' })]);
    await call(friend, 'POST', `/v1/rooms/${room.id}/join`);
    expect((await call(friend, 'POST', `/v1/rooms/${room.id}/messages`, { text: 'yo' })).status).toBe(200);

    expect((await call(friend, 'POST', `/v1/rooms/${room.id}/grants`, { kind: 'player', id: 99 })).status).toBe(403);
    await call(owner, 'DELETE', `/v1/rooms/${room.id}/grants/player/21`);
    expect((await call(friend, 'POST', `/v1/rooms/${room.id}/messages`, { text: 'yo' })).status).toBe(404);
  });

  it('lets a player leave, and a new personal invite brings the room back', async () => {
    const owner = await login(12, 0);
    const friend = await login(22, 0);
    const room = await createRoom(owner);
    await call(owner, 'POST', `/v1/rooms/${room.id}/grants`, { kind: 'player', id: 22 });
    await call(friend, 'POST', `/v1/rooms/${room.id}/join`);
    expect((await call(friend, 'POST', `/v1/rooms/${room.id}/leave`)).status).toBe(200);
    expect((await call<{ rooms: RoomView[] }>(friend, 'GET', '/v1/rooms')).body.rooms).toEqual([]);
    expect((await call(owner, 'POST', `/v1/rooms/${room.id}/leave`)).status).toBe(409);
    await call(owner, 'POST', `/v1/rooms/${room.id}/grants`, { kind: 'player', id: 22 });
    expect((await call<{ rooms: RoomView[] }>(friend, 'GET', '/v1/rooms')).body.rooms).toEqual([expect.objectContaining({ joined: false })]);
  });

  it('admins can invite and ban, members cannot; bans hide the room', async () => {
    const owner = await login(13, 0);
    const mod = await login(23, 0);
    const member = await login(33, 0);
    const room = await createRoom(owner);
    for (const id of [23, 33]) await call(owner, 'POST', `/v1/rooms/${room.id}/grants`, { kind: 'player', id });
    await call(mod, 'POST', `/v1/rooms/${room.id}/join`);
    await call(member, 'POST', `/v1/rooms/${room.id}/join`);

    expect((await call(member, 'POST', `/v1/rooms/${room.id}/admins/23`)).status).toBe(403);
    expect((await call(owner, 'POST', `/v1/rooms/${room.id}/admins/23`)).status).toBe(200);
    expect((await call(mod, 'POST', `/v1/rooms/${room.id}/grants`, { kind: 'faction', id: 555 })).status).toBe(200);
    expect((await call(member, 'POST', `/v1/rooms/${room.id}/bans/23`)).status).toBe(403);
    expect((await call(mod, 'POST', `/v1/rooms/${room.id}/bans/13`)).status).toBe(403);
    expect((await call(mod, 'POST', `/v1/rooms/${room.id}/bans/33`)).status).toBe(200);
    expect((await call<{ rooms: RoomView[] }>(member, 'GET', '/v1/rooms')).body.rooms).toEqual([]);
    expect((await call(member, 'GET', `/v1/rooms/${room.id}/messages`)).status).toBe(404);

    const access = await call<AccessView>(owner, 'GET', `/v1/rooms/${room.id}/access`);
    expect(access.body.members.map((m) => [m.id, m.role])).toEqual([
      [13, 'owner'],
      [23, 'admin'],
    ]);
    expect(access.body.bans.map((b) => b.id)).toEqual([33]);
  });

  it('caps owned rooms and refuses public rooms from regular players', async () => {
    const owner = await login(14, 0);
    expect((await call(owner, 'POST', '/v1/rooms', { name: 'Pub', visibility: 'public' })).status).toBe(403);
    for (let i = 0; i < 10; i++) await createRoom(owner, { name: `Room ${i}` });
    expect((await call(owner, 'POST', '/v1/rooms', { name: 'One too many' })).status).toBe(409);
    expect((await call(owner, 'POST', '/v1/rooms', { name: '   ' })).status).toBe(400);
  });

  it('shows faction tags before names when the owner turns them on', async () => {
    const owner = await login(4100, 77);
    const room = await createRoom(owner, { name: 'Alliance', showFactionTags: true });
    expect(room.showFactionTags).toBe(true);
    const sent = await call<MessageView>(owner, 'POST', `/v1/rooms/${room.id}/messages`, { text: 'hi' });
    expect(sent.body.factionTag).toBe('F77');
    expect((await call<RoomView>(owner, 'PATCH', `/v1/rooms/${room.id}`, { showFactionTags: false })).body.showFactionTags).toBe(false);
    expect((await call<RoomView>(owner, 'PATCH', `/v1/rooms/${room.id}`, { name: 'Renamed' })).body.showFactionTags).toBe(false);
    expect((await createRoom(owner, { name: 'Plain' })).showFactionTags).toBe(false);
  });

  it('rate-limits messages', async () => {
    const owner = await login(15, 0);
    const room = await createRoom(owner);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await call(owner, 'POST', `/v1/rooms/${room.id}/messages`, { text: `m${i}` })).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });
});

describe('public rooms', () => {
  it('site admins publish topic rooms anyone can browse and join; announcement rooms block members', async () => {
    const admin = await login(1, 0);
    const player = await login(40, 400);
    const room = await createRoom(admin, { name: 'War talk', topic: 'war', icon: 'assault', visibility: 'public', postPolicy: 'admins' });
    expect(room.icon).toBe('assault');
    expect(room.color).toBe('');
    expect((await call<RoomView>(admin, 'PATCH', `/v1/rooms/${room.id}`, { color: '#B22222' })).body.color).toBe('#b22222');
    expect((await call<RoomView>(admin, 'PATCH', `/v1/rooms/${room.id}`, { color: 'red; background:url(x)' })).body.color).toBe('');
    expect((await createRoom(admin, { name: 'Odd icon', icon: '<script>' })).icon).toBe('');
    const browse = await call<{ rooms: BrowseRoom[] }>(player, 'GET', '/v1/rooms/browse?q=war');
    expect(browse.body.rooms).toEqual([expect.objectContaining({ id: room.id, icon: 'assault', memberCount: 1, joined: false })]);
    // Public rooms are readable before joining but are not in the list until joined.
    expect((await call(player, 'GET', `/v1/rooms/${room.id}/messages`)).status).toBe(200);
    expect((await call<{ rooms: RoomView[] }>(player, 'GET', '/v1/rooms')).body.rooms).toEqual([]);
    await call(player, 'POST', `/v1/rooms/${room.id}/join`);
    expect((await call(player, 'POST', `/v1/rooms/${room.id}/messages`, { text: 'hi' })).status).toBe(403);
    expect((await call(admin, 'PATCH', `/v1/rooms/${room.id}`, { postPolicy: 'everyone' })).status).toBe(200);
    expect((await call(player, 'POST', `/v1/rooms/${room.id}/messages`, { text: 'hi' })).status).toBe(200);
    expect((await call(player, 'PATCH', `/v1/rooms/${room.id}`, { name: 'Mine now' })).status).toBe(403);
  });
});

describe('polling (Torn PDA cannot read a stream)', () => {
  it('shows invitations, then delivers new messages only to members', async () => {
    const owner = await login(4600, 4601);
    const leader = await login(4602, 4603);
    const outsider = await login(4604, 0);
    const room = await createRoom(owner, { name: 'Leaders' });
    expect((await call(owner, 'POST', `/v1/rooms/${room.id}/grants`, { kind: 'faction', id: 4603, label: 'Their faction' })).status).toBe(200);

    const first = (await call<PollResponse>(leader, 'GET', '/v1/poll?open=')).body;
    expect(first.rooms.find((r) => r.id === room.id)?.joined).toBe(false);
    expect(first.messages).toEqual([]);

    expect((await call(leader, 'POST', `/v1/rooms/${room.id}/join`)).status).toBe(200);
    const opened = (await call<PollResponse>(leader, 'GET', `/v1/poll?open=${room.id}`)).body;
    expect(opened.history[room.id]).toEqual([]);
    await call(owner, 'POST', `/v1/rooms/${room.id}/messages`, { text: 'ceasefire?' });

    const next = (await call<PollResponse>(leader, 'GET', `/v1/poll?open=${room.id}&after=${opened.cursor}`)).body;
    expect(next.messages.map((m) => m.text)).toEqual(['ceasefire?']);
    expect(next.rooms.find((r) => r.id === room.id)?.unread).toBe(1);
    expect(next.cursor).toBeGreaterThan(opened.cursor);

    const theirs = (await call<PollResponse>(outsider, 'GET', `/v1/poll?open=${room.id}&after=${opened.cursor}`)).body;
    expect(theirs.messages).toEqual([]);
    expect(theirs.rooms.find((r) => r.id === room.id)).toBeUndefined();
  });
});

describe('live updates', () => {
  it('streams messages only to joined members with access, and tells invitees their list changed', async () => {
    const owner = await login(16, 160);
    const ally = await login(26, 260);
    const outsider = await login(36, 360);
    const room = await createRoom(owner);
    await call(owner, 'POST', `/v1/rooms/${room.id}/messages`, { text: 'history' });
    const o = await stream(owner, [room.id]);
    const a = await stream(ally, [room.id]);
    const x = await stream(outsider);
    await tick();
    // hello: the owner gets the room and its history; others get nothing they cannot see.
    expect(o.events[0]).toMatchObject({ t: 'hello', rooms: [expect.objectContaining({ id: room.id })] });
    expect((o.events[0] as any).history[room.id].map((m: MessageView) => m.text)).toEqual(['history']);
    expect(a.events[0]).toEqual({ t: 'hello', rooms: [], history: {} });
    expect(x.events[0]).toEqual({ t: 'hello', rooms: [], history: {} });
    for (const s of [o, a, x]) s.events.shift();

    await call(owner, 'POST', `/v1/rooms/${room.id}/grants`, { kind: 'faction', id: 260 });
    await tick();
    expect(a.events).toContainEqual({ t: 'rooms_changed' });
    expect(x.events).toEqual([]);

    await call(owner, 'POST', `/v1/rooms/${room.id}/messages`, { text: 'before join' });
    await tick();
    expect(o.events.some((e) => e.t === 'msg')).toBe(true);
    expect(a.events.some((e) => e.t === 'msg')).toBe(false);

    await call(ally, 'POST', `/v1/rooms/${room.id}/join`);
    const sent = await call<MessageView>(owner, 'POST', `/v1/rooms/${room.id}/messages`, { text: 'after join' });
    await tick();
    expect(a.events).toContainEqual({ t: 'msg', msg: sent.body });
    expect(x.events.some((e) => e.t === 'msg')).toBe(false);

    await call(owner, 'DELETE', `/v1/rooms/${room.id}/messages/${sent.body.id}`);
    await tick();
    expect(a.events).toContainEqual({ t: 'msg_deleted', roomId: room.id, id: sent.body.id });
    for (const s of [o, a, x]) await s.close();
  });
});

describe('typing', () => {
  it('tells members who is typing, by stream and poll, until they send; outsiders get nothing', async () => {
    const owner = await login(5600, 5601);
    const member = await login(5602, 5601);
    const outsider = await login(5604, 0);
    const room = await createRoom(owner, { name: 'Typing' });
    expect((await call(owner, 'POST', `/v1/rooms/${room.id}/grants`, { kind: 'faction', id: 5601, label: 'Us' })).status).toBe(200);
    expect((await call(member, 'POST', `/v1/rooms/${room.id}/join`)).status).toBe(200);
    const m = await stream(member, [room.id]);
    const o = await stream(owner, [room.id]);
    await tick();

    expect((await call(owner, 'POST', `/v1/rooms/${room.id}/typing`)).status).toBe(200);
    expect((await call(outsider, 'POST', `/v1/rooms/${room.id}/typing`)).status).toBe(404);
    await tick();
    const ev = m.events.find((e) => e.t === 'typing');
    expect(ev?.t === 'typing' && ev.users.map((u) => [u.userId, u.name])).toEqual([[5600, 'Player5600']]);
    expect(o.events.some((e) => e.t === 'typing')).toBe(false);

    const polled = (await call<PollResponse>(member, 'GET', '/v1/poll?open=')).body;
    expect(polled.typing[room.id]?.map((u) => u.userId)).toEqual([5600]);
    expect((await call<PollResponse>(owner, 'GET', '/v1/poll?open=')).body.typing).toEqual({});
    expect((await call<PollResponse>(outsider, 'GET', '/v1/poll?open=')).body.typing).toEqual({});

    await call(owner, 'POST', `/v1/rooms/${room.id}/messages`, { text: 'done' });
    expect((await call<PollResponse>(member, 'GET', '/v1/poll?open=')).body.typing).toEqual({});
    for (const s of [m, o]) await s.close();
  });

  it('has its own limit, outside the write budget', async () => {
    const owner = await login(5700, 0);
    const room = await createRoom(owner, { name: 'Chatty' });
    for (let i = 0; i < LIMITS.typingPerMinute; i++) expect((await call(owner, 'POST', `/v1/rooms/${room.id}/typing`)).status).toBe(200);
    expect((await call(owner, 'POST', `/v1/rooms/${room.id}/typing`)).status).toBe(429);
    expect((await call(owner, 'POST', `/v1/rooms/${room.id}/messages`, { text: 'still fine' })).status).toBe(200);
  });
});

describe('reactions', () => {
  it('members toggle the fixed reactions; streams and polls carry the change, outsiders cannot react', async () => {
    const owner = await login(5800, 5801);
    const member = await login(5802, 5801);
    const outsider = await login(5804, 0);
    const room = await createRoom(owner, { name: 'Reacts' });
    await call(owner, 'POST', `/v1/rooms/${room.id}/grants`, { kind: 'faction', id: 5801, label: 'Us' });
    await call(member, 'POST', `/v1/rooms/${room.id}/join`);
    const msg = (await call<MessageView>(owner, 'POST', `/v1/rooms/${room.id}/messages`, { text: 'we won' })).body;
    expect(msg.reactions).toEqual([]);
    const first = (await call<PollResponse>(member, 'GET', `/v1/poll?open=${room.id}`)).body;
    expect(first.reactions).toEqual([]);
    const o = await stream(owner, [room.id]);
    await tick();
    o.events.shift();

    const path = `/v1/rooms/${room.id}/messages/${msg.id}/reactions`;
    expect((await call(member, 'POST', path, { emoji: '🔥' })).status).toBe(200);
    expect((await call(owner, 'POST', path, { emoji: '👍' })).status).toBe(200);
    const both = await call(member, 'POST', path, { emoji: '👍', on: true });
    const expected = [
      { emoji: '🔥', users: [{ id: 5802, name: 'Player5802' }] },
      { emoji: '👍', users: [{ id: 5800, name: 'Player5800' }, { id: 5802, name: 'Player5802' }] },
    ];
    expect(both.body).toEqual({ roomId: room.id, id: msg.id, reactions: expected });
    // Adding twice changes nothing; anything outside the picker is refused.
    expect((await call(member, 'POST', path, { emoji: '👍' })).body.reactions).toEqual(expected);
    expect((await call(member, 'POST', path, { emoji: '💩' })).status).toBe(400);
    expect((await call(outsider, 'POST', path, { emoji: '👍' })).status).toBe(404);
    await tick();
    expect(o.events.filter((e) => e.t === 'reactions').length).toBe(3);
    expect(o.events.at(-1)).toEqual({ t: 'reactions', roomId: room.id, id: msg.id, reactions: expected });

    const history = (await call<{ messages: MessageView[] }>(owner, 'GET', `/v1/rooms/${room.id}/messages`)).body.messages;
    expect(history.find((m) => m.id === msg.id)?.reactions).toEqual(expected);
    const polled = (await call<PollResponse>(member, 'GET', `/v1/poll?open=&after=${first.cursor}&reactionsAfter=${first.reactionCursor}`)).body;
    expect(polled.reactions).toEqual([{ roomId: room.id, id: msg.id, reactions: expected }]);
    const outsiderPoll = (await call<PollResponse>(outsider, 'GET', `/v1/poll?open=&after=0&reactionsAfter=${first.reactionCursor}`)).body;
    expect(outsiderPoll.reactions).toEqual([]);

    const off = await call(owner, 'POST', path, { emoji: '👍', on: false });
    expect(off.body.reactions[1]).toEqual({ emoji: '👍', users: [{ id: 5802, name: 'Player5802' }] });
    const again = (await call<PollResponse>(member, 'GET', `/v1/poll?open=&after=${polled.cursor}&reactionsAfter=${polled.reactionCursor}`)).body;
    expect(again.reactions.map((u) => u.reactions[1].users.length)).toEqual([1]);

    await call(owner, 'DELETE', `/v1/rooms/${room.id}/messages/${msg.id}`);
    expect((await call(member, 'POST', path, { emoji: '👍' })).status).toBe(404);
    await o.close();
  });
});

describe('mentions', () => {
  it('tags members named with @, never the sender, outsiders or people who have not joined', async () => {
    const owner = await login(5900, 5901);
    const member = await login(5902, 5901);
    const pending = await login(5903, 5901); // in the invited faction, has not opened the room
    await login(5904, 0); // outsider
    const room = await createRoom(owner, { name: 'Tags' });
    await call(owner, 'POST', `/v1/rooms/${room.id}/grants`, { kind: 'faction', id: 5901, label: 'Us' });
    await call(member, 'POST', `/v1/rooms/${room.id}/join`);
    const m = await stream(member, [room.id]);
    await tick();

    const msg = (
      await call<MessageView>(owner, 'POST', `/v1/rooms/${room.id}/messages`, {
        text: '@player5902 and @Player5902, @Player5903 @Player5904 @Player5900 a@Player5902.com @Nobody',
      })
    ).body;
    expect(msg.mentions).toEqual([{ id: 5902, name: 'Player5902' }]);
    await tick();
    expect(m.events.find((e) => e.t === 'msg')).toMatchObject({ msg: { id: msg.id, mentions: [{ id: 5902, name: 'Player5902' }] } });

    const rooms = async (token: string) => (await call<{ rooms: RoomView[] }>(token, 'GET', '/v1/rooms')).body.rooms.find((r) => r.id === room.id);
    expect((await rooms(member))?.mentions).toEqual([msg.id]);
    expect((await rooms(owner))?.mentions).toEqual([]);
    expect((await rooms(pending))?.mentions).toEqual([]);
    // Reading the room does not see the mention: only the message coming into view does.
    await call(member, 'POST', `/v1/rooms/${room.id}/read`, { id: msg.id });
    expect((await rooms(member))?.mentions).toEqual([msg.id]);
    const history = (await call<{ messages: MessageView[] }>(member, 'GET', `/v1/rooms/${room.id}/messages`)).body.messages;
    expect(history.find((x) => x.id === msg.id)?.mentions).toEqual([{ id: 5902, name: 'Player5902' }]);
    const polled = (await call<PollResponse>(member, 'GET', '/v1/poll?open=&after=0')).body;
    expect(polled.messages.find((x) => x.id === msg.id)?.mentions).toEqual([{ id: 5902, name: 'Player5902' }]);
    expect(polled.rooms.find((r) => r.id === room.id)?.mentions).toEqual([msg.id]);

    // Only your own mentions can be seen, and seeing them tells your other tabs.
    expect((await call(owner, 'POST', `/v1/rooms/${room.id}/mentions/seen`, { ids: [msg.id] })).status).toBe(200);
    expect((await rooms(member))?.mentions).toEqual([msg.id]);
    expect((await call(member, 'POST', `/v1/rooms/${room.id}/mentions/seen`, { ids: 'all' })).status).toBe(400);
    expect((await call(member, 'POST', `/v1/rooms/${room.id}/mentions/seen`, { ids: [msg.id] })).status).toBe(200);
    expect((await rooms(member))?.mentions).toEqual([]);
    await tick();
    expect(m.events.at(-1)).toEqual({ t: 'mentions_seen', roomId: room.id, ids: [msg.id] });

    // A deleted message takes its mention with it.
    const again = (await call<MessageView>(owner, 'POST', `/v1/rooms/${room.id}/messages`, { text: 'hey @Player5902' })).body;
    expect((await rooms(member))?.mentions).toEqual([again.id]);
    await call(owner, 'DELETE', `/v1/rooms/${room.id}/messages/${again.id}`);
    expect((await rooms(member))?.mentions).toEqual([]);
    await m.close();
  });
});
