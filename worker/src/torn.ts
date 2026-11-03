// Verifies a Torn API key and returns who owns it.
// The key goes in the query string, not the Authorization header: header-auth
// /v2/user responses have been seen served to the wrong user (cache vary bug).

export interface TornIdentity {
  id: number;
  name: string;
  factionId: number | null;
  factionTag: string | null;
  avatar: string | null;
}

export class TornError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

interface TornErrorBody {
  error?: { code: number; error: string };
}

async function get<T>(base: string, path: string, key: string): Promise<T> {
  const url = `${base}${path}?key=${encodeURIComponent(key)}&comment=torn-rooms&timestamp=${Date.now()}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'torn-rooms/0.1' } });
  if (!res.ok) throw new TornError(502, `Torn API HTTP ${res.status}`);
  const body = (await res.json()) as T & TornErrorBody;
  if (body.error) {
    const { code, error } = body.error;
    if (code === 2) throw new TornError(401, 'Incorrect API key');
    if (code === 5) throw new TornError(429, 'Torn API rate limit, try again in a minute');
    if (code === 13 || code === 18) throw new TornError(401, 'API key is disabled or paused');
    if (code === 16) throw new TornError(401, 'API key access level is too low');
    throw new TornError(502, `Torn API error ${code}: ${error}`);
  }
  return body;
}

export async function verifyKey(base: string, key: string): Promise<TornIdentity> {
  if (!/^[A-Za-z0-9]{16}$/.test(key)) throw new TornError(400, 'An API key is 16 letters and digits');
  const [basic, faction] = await Promise.all([
    get<{ profile: { id: number; name: string; image: string | null; status?: { state?: string } } }>(base, '/user/profile', key),
    get<{ faction: { id: number; tag: string } | null }>(base, '/user/faction', key),
  ]);
  if (!basic.profile || typeof basic.profile.id !== 'number') throw new TornError(502, 'Unexpected Torn API response');
  // Players Torn put in federal jail (banned for breaking its rules) cannot use the rooms; checked at every login.
  if (basic.profile.status?.state === 'Federal') throw new TornError(403, 'Players in federal jail cannot use Torn Rooms');
  return {
    id: basic.profile.id,
    name: basic.profile.name,
    factionId: faction.faction ? faction.faction.id : null,
    factionTag: faction.faction ? faction.faction.tag : null,
    avatar: typeof basic.profile.image === 'string' && basic.profile.image.startsWith('https://') ? basic.profile.image : null,
  };
}
