// HTTP entry: CORS, API-key login, token checks, routing to the Hub object.
import { LIMITS, type AuthResponse } from '../../shared/protocol';
import { Hub, type Caller, type Env, type Res } from './hub';
import { signToken, verifyToken } from './token';
import { TornError, verifyKey } from './torn';

export { Hub };

function corsHeaders(env: Env, origin: string | null): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors } });
}

function superadmins(env: Env): Set<number> {
  return new Set(env.SUPERADMINS.split(',').map((s) => Number(s.trim())).filter((n) => n > 0));
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function login(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const { key, pageUserId, showAvatar } = await readJson(request);
  // The script reports which player is logged in to Torn in this browser. A modified script can
  // lie, so this is not proof of identity; it stops someone using another player's key with the
  // published script (bought or leaked keys).
  const pageUser = Number(pageUserId);
  if (!Number.isInteger(pageUser) || pageUser <= 0) return json({ error: 'Open Torn while logged in to log in to Torn Rooms' }, 400, cors);
  const hub = env.HUB.get(env.HUB.idFromName('hub'));
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip && !(await hub.allowLogin(ip))) return json({ error: 'Too many logins, try again in a few minutes' }, 429, cors);
  try {
    const who = await verifyKey(env.TORN_API_BASE, typeof key === 'string' ? key.trim() : '');
    if (who.id !== pageUser) return json({ error: `This key belongs to ${who.name} [${who.id}], not you. Use your own key.` }, 403, cors);
    const consent = typeof showAvatar === 'boolean' ? showAvatar : undefined;
    const { banned, showAvatar: show } = await hub.upsertUser(who, consent);
    if (banned) return json({ error: 'You are banned from Torn Rooms' }, 403, cors);
    const exp = Date.now() + LIMITS.tokenTtlMs;
    const token = await signToken({ ...who, exp }, env.TOKEN_SECRET);
    const body: AuthResponse = { token, exp, me: { ...who, showAvatar: show, superadmin: superadmins(env).has(who.id) } };
    return json(body, 200, cors);
  } catch (e) {
    if (e instanceof TornError) return json({ error: e.message }, e.status, cors);
    throw e;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(env, request.headers.get('Origin'));
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/v1/auth' && request.method === 'POST') return login(request, env, cors);
    if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true, service: 'torn-rooms' }, 200, cors);

    // Header only: a token in the URL would end up in request logs.
    const bearer = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    const user = bearer ? await verifyToken(bearer, env.TOKEN_SECRET) : null;
    if (!user) return json({ error: 'Session expired' }, 401, cors);
    const caller: Caller = { ...user, superadmin: superadmins(env).has(user.id) };
    const hub = env.HUB.get(env.HUB.idFromName('hub'));

    if (url.pathname === '/v1/events' && request.method === 'GET') {
      const res = await hub.fetch(new Request(request.url, { headers: { 'x-caller': JSON.stringify(caller) } }));
      return new Response(res.body, { status: res.status, headers: { ...Object.fromEntries(res.headers), ...cors } });
    }

    const m = request.method;
    const body = m === 'POST' || m === 'PATCH' ? await readJson(request) : {};
    const res = await hub.api(caller, m, url.pathname, Object.fromEntries(url.searchParams), body);
    return json(res.body, res.status, cors);
  },
} satisfies ExportedHandler<Env>;
