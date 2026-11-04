// Talks to the Torn Rooms server. Everything goes through GM_xmlhttpRequest:
// Torn's Content-Security-Policy blocks fetch and WebSocket to other hosts,
// even from Tampermonkey's sandbox, while GM requests run in the extension.
import { LIMITS, type AuthResponse, type PollResponse, type ServerEvent } from '../../shared/protocol';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const KEY = 'apiKey';
const SESSION = 'session';
const KEY_OWNER = 'keyOwner';

/** The player logged in to Torn in this tab, from Torn's own page data. */
export function pageUserId(): number | null {
  try {
    const id = Number(JSON.parse((document.getElementById('torn-user') as HTMLInputElement | null)?.value ?? '{}').id);
    if (id > 0) return id;
  } catch {
    // fall through to the sidebar link
  }
  const link = document.querySelector('#sidebar a[href*="profiles.php?XID="]')?.getAttribute('href');
  const id = Number(/XID=(\d+)/.exec(link ?? '')?.[1]);
  return id > 0 ? id : null;
}

function request(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method,
      url: __API_BASE__ + path,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      data: body === undefined ? undefined : JSON.stringify(body),
      timeout: 20_000,
      onload: (r) => {
        let data: any = null;
        try {
          data = JSON.parse(r.responseText);
        } catch {
          data = { error: r.responseText.slice(0, 200) };
        }
        resolve({ status: r.status, data });
      },
      onerror: () => reject(new ApiError(0, 'Cannot reach Torn Rooms')),
      ontimeout: () => reject(new ApiError(0, 'Torn Rooms took too long to answer')),
    });
  });
}

// Torn PDA replaces this placeholder with the player's own key, so PDA users never paste one.
const PDA_KEY = '###PDA-APIKEY###';
function storedKey(): string {
  return GM_getValue<string>(KEY, '') || (/^[A-Za-z0-9]{16}$/.test(PDA_KEY) ? PDA_KEY : '');
}

export function hasKey(): boolean {
  return !!storedKey();
}

/** A saved session, only if it belongs to the player logged in to Torn in this tab. */
export function storedSession(): AuthResponse | null {
  const s = GM_getValue<AuthResponse | null>(SESSION, null);
  return s && s.exp - Date.now() > 60_000 && s.me.id === pageUserId() ? s : null;
}

/** showAvatar: the player's choice when logging in from the form; omitted on automatic re-logins. */
export async function login(key: string, showAvatar?: boolean): Promise<AuthResponse> {
  const pageUser = pageUserId();
  if (!pageUser) throw new ApiError(400, 'Open Torn while logged in to log in to Torn Rooms');
  const res = await request('POST', '/v1/auth', { key: key.trim(), pageUserId: pageUser, showAvatar });
  if (res.status !== 200) throw new ApiError(res.status, res.data?.error ?? 'Login failed');
  GM_setValue(KEY, key.trim());
  GM_setValue(KEY_OWNER, res.data.me.id);
  GM_setValue(SESSION, res.data);
  return res.data as AuthResponse;
}

/** Changes the profile-picture consent and keeps the saved session in step. */
export async function setShowAvatar(show: boolean): Promise<void> {
  await api('PATCH', '/v1/me', { showAvatar: show });
  const s = GM_getValue<AuthResponse | null>(SESSION, null);
  if (s) GM_setValue(SESSION, { ...s, me: { ...s.me, showAvatar: show } });
}

export function logout(): void {
  GM_deleteValue(KEY);
  GM_deleteValue(KEY_OWNER);
  GM_deleteValue(SESSION);
}

let pending: Promise<AuthResponse> | null = null;

/**
 * Resolves once the player is on this tab: visible, and focused or touched. Torn's rules allow
 * sending data from a Torn page (here the logged-in player's id) only while it is actively viewed.
 */
function whenActive(): Promise<void> {
  const active = () => document.visibilityState === 'visible' && document.hasFocus();
  if (active()) return Promise.resolve();
  return new Promise((resolve) => {
    const events = ['focus', 'pointerdown', 'keydown'];
    const done = () => {
      if (document.visibilityState !== 'visible') return;
      for (const e of events) window.removeEventListener(e, done, true);
      resolve();
    };
    for (const e of events) window.addEventListener(e, done, true);
  });
}

/** A valid session, logging in again with the stored key when the token is about to expire. */
export async function session(force = false): Promise<AuthResponse> {
  const s = force ? null : storedSession();
  if (s) return s;
  const key = storedKey();
  if (!key) throw new ApiError(401, 'Not logged in');
  // Switched Torn accounts in this browser: the saved key is someone else's, so don't send it.
  const owner = GM_getValue<number>(KEY_OWNER, 0);
  const pageUser = pageUserId();
  if (owner && pageUser && owner !== pageUser) throw new ApiError(403, `Your saved key belongs to player [${owner}], not the player logged in here. Log in with this player's own key.`);
  // Automatic re-logins (expired token, a tab loaded in the background) wait for the player to look at the tab.
  pending ??= whenActive().then(() => login(key))
    .catch((e) => {
      // Refused for good (another player's key, or banned): forget it instead of retrying every page.
      if (e instanceof ApiError && e.status === 403) logout();
      throw e;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res = await request(method, path, body, (await session()).token);
  if (res.status === 401) res = await request(method, path, body, (await session(true)).token);
  if (res.status !== 200) throw new ApiError(res.status, res.data?.error ?? `Request failed (${res.status})`);
  return res.data as T;
}

export type ConnState = 'connecting' | 'live' | 'offline';

/**
 * Keeps a Server-Sent Events stream open, reconnecting with backoff. Returns a stop function.
 * Every connection starts with a hello event (rooms + history of `openRooms()`), so a page load
 * or a reconnect needs no other request.
 */
export function openEvents(openRooms: () => string[], onEvent: (ev: ServerEvent) => void, onState: (s: ConnState) => void): () => void {
  if (!canStream()) return pollEvents(openRooms, onEvent, onState);
  let stopped = false;
  let current: { abort(): void } | null = null;
  let delay = 1000;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const retry = () => {
    if (stopped) return;
    onState('offline');
    timer = setTimeout(connect, delay);
    delay = Math.min(delay * 2, 30_000);
  };

  async function connect() {
    if (stopped) return;
    onState('connecting');
    let token: string;
    try {
      token = (await session()).token;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return onState('offline');
      return retry();
    }
    let ended = false;
    let replaced = false;
    const end = () => {
      if (ended) return;
      ended = true;
      if (!replaced) return retry();
      // Too many Torn tabs: a newer one took this stream. Come back when this tab is looked at again
      // (which in turn replaces the oldest), instead of fighting over it.
      onState('offline');
      const resume = () => {
        if (document.visibilityState !== 'visible') return;
        document.removeEventListener('visibilitychange', resume);
        connect();
      };
      document.addEventListener('visibilitychange', resume);
    };
    current = GM_xmlhttpRequest({
      method: 'GET',
      url: `${__API_BASE__}/v1/events?open=${openRooms().map(encodeURIComponent).join(',')}`,
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
      responseType: 'stream',
      onloadstart: async (r) => {
        if (r.status && r.status !== 200) {
          if (r.status === 401) await session(true).catch(() => {});
          if (r.status === 403) {
            // Banned: retrying cannot help.
            ended = true;
            return onState('offline');
          }
          return end();
        }
        const reader = (r.response as ReadableStream<Uint8Array>).getReader();
        const dec = new TextDecoder();
        let buf = '';
        delay = 1000;
        onState('live');
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i: number;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const frame = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const lines = frame.split('\n');
              const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
              if (event === 'expired') await session(true).catch(() => {});
              if (event === 'replaced') replaced = true;
              const data = lines.find((l) => l.startsWith('data: '));
              if (!event && data) onEvent(JSON.parse(data.slice(6)) as ServerEvent);
            }
          }
        } catch {
          // stream broke; reconnect below
        }
        end();
      },
      onerror: end,
      onabort: () => {
        ended = true;
      },
    });
  }

  connect();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    current?.abort();
  };
}

/**
 * Torn PDA routes GM_xmlhttpRequest through its native HTTP handler, which hands back a response only
 * once it is complete, so a stream that never ends never arrives. It also runs scripts in an
 * InAppWebView, which is how we recognise it.
 */
function canStream(): boolean {
  return !__FORCE_POLL__ && typeof (window as { flutter_inappwebview?: unknown }).flutter_inappwebview === 'undefined';
}

/** The stream's events from GET /v1/poll: a hello first, then the room list and new messages. */
function pollEvents(openRooms: () => string[], onEvent: (ev: ServerEvent) => void, onState: (s: ConnState) => void): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cursor: number | null = null;
  let failures = 0;

  const schedule = () => {
    if (stopped) return;
    const visible = document.visibilityState === 'visible';
    // Fast only while a room panel is open: the bar and the rooms list can wait a little.
    const base = !visible ? LIMITS.pollHiddenMs : openRooms().length ? LIMITS.pollMs : LIMITS.pollIdleMs;
    timer = setTimeout(tick, Math.min(base * 2 ** failures, 60_000));
  };
  // Coming back to the app should not wait out the slow background interval.
  const onVisible = () => {
    if (document.visibilityState !== 'visible' || stopped) return;
    if (timer) clearTimeout(timer);
    tick();
  };
  document.addEventListener('visibilitychange', onVisible);

  async function tick() {
    timer = null;
    if (stopped) return;
    try {
      const open = openRooms().map(encodeURIComponent).join(',');
      const res = await api<PollResponse>('GET', `/v1/poll?open=${open}${cursor === null ? '' : `&after=${cursor}`}`);
      if (stopped) return;
      // The room list first: it already counts the new messages as unread, so they are not counted twice.
      onEvent({ t: 'hello', rooms: res.rooms, history: res.history });
      for (const msg of res.messages) onEvent({ t: 'msg', msg });
      for (const [roomId, users] of Object.entries(res.typing ?? {})) onEvent({ t: 'typing', roomId, users });
      cursor = res.cursor;
      failures = 0;
      onState('live');
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        stopped = true; // banned
        return onState('offline');
      }
      failures = Math.min(failures + 1, 4);
      onState('offline');
    }
    schedule();
  }

  onState('connecting');
  tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

