// Local stand-in for api.torn.com used by `wrangler dev` (TORN_API_BASE in .dev.vars).
// Fake keys "k" + 7-digit player id + 8-digit faction id (00000000 = no faction) log in
// test players; any other key is forwarded to the real Torn API.
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8792);
const FACTIONS = { 1: 'Tesseract', 2: 'Allies United', 3: 'The Enemy' };

http
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
    if (url.pathname === '/v2/user/profile') return send({ profile: { id: uid, name: `Tester${uid}`, image: process.env.STUB_AVATAR ?? null } });
    if (url.pathname === '/v2/user/faction')
      return send({ faction: fid ? { id: fid, name: FACTIONS[fid] ?? `Faction ${fid}`, tag: `F${fid}`, tag_image: '', position: 'Member', days_in_faction: 10 } : null });
    send({ error: { code: 9, error: 'stub: unknown path' } });
  })
  .listen(PORT, '127.0.0.1', () => console.log(`torn stub on ${PORT}`));
