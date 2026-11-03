// Local stand-in for api.torn.com used by `wrangler dev` (TORN_API_BASE in .dev.vars).
// Fake keys "k" + 7-digit player id + 8-digit faction id (00000000 = no faction) log in
// test players; any other key is forwarded to the real Torn API.
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8792);
// Fictional factions and players for local testing and the README screenshots (tools/demo-seed.mjs).
const FACTIONS = { 1: ['Onyx Syndicate', 'ONYX'], 2: ['Vex', 'VEX'], 3: ['Koi Cartel', 'KOI'] };
const AVATARS = 'https://raw.githubusercontent.com/manuelcecchetto/torn-rooms/main/docs/avatars/';
export const CAST = {
  2100001: ['Gh0stline', 'ghost'], 2100002: ['FoxyRoxy', 'foxy'], 2100003: ['Redline', 'redline'],
  2100004: ['Bonez', 'bonez'], 2100005: ['SmokeyJoe', 'smokey'], 2100006: ['Whiskers', 'whiskers'],
  2100007: ['HeistKing', 'heist'], 2100008: ['NeonByte', 'neonbyte'], 2100009: ['DonVito', 'donvito'],
};

if (import.meta.url === `file://${process.argv[1]}`) http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const key = url.searchParams.get('key') ?? '';
    const send = (body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const m = /^k(\d{7})(\d{8})$/.exec(key);
    if (!m) {
      const upstream = await fetch(`https://api.torn.com${url.pathname}${url.search}`, { headers: { 'User-Agent': 'torn-rooms-dev/0.1' } });
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      return res.end(await upstream.text());
    }
    const uid = Number(m[1]);
    const fid = Number(m[2]);
    // STUB_AVATAR=<url> gives test players a picture, to test the consent setting.
    const [name, avatar] = CAST[uid] ?? [process.env.STUB_NAME && uid === Number(process.env.STUB_UID) ? process.env.STUB_NAME : `Tester${uid}`, null];
    const image = avatar ? `${AVATARS}${avatar}.png` : (process.env.STUB_AVATAR ?? null);
    if (url.pathname === '/v2/user/profile') return send({ profile: { id: uid, name, image, status: { state: 'Okay' } } });
    if (url.pathname === '/v2/user/faction')
      return send({ faction: fid ? { id: fid, name: FACTIONS[fid]?.[0] ?? `Faction ${fid}`, tag: FACTIONS[fid]?.[1] ?? `F${fid}`, tag_image: '', position: 'Member', days_in_faction: 10 } : null });
    send({ error: { code: 9, error: 'stub: unknown path' } });
  })
  .listen(PORT, '127.0.0.1', () => console.log(`torn stub on ${PORT}`));
