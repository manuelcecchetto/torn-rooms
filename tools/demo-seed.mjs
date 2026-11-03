// Fills a fresh local stack (wrangler dev + tools/dev-torn-stub.mjs) with the fictional
// factions, players, rooms and chats used for the README screenshots.
//   node tools/demo-seed.mjs [yourPlayerId]   (that player must be in SUPERADMINS in worker/.dev.vars)
const API = process.env.TR_API_BASE ?? 'http://127.0.0.1:8788';
const ME = Number(process.argv[2] ?? 1);
const ONYX = 1, VEX = 2, KOI = 3;
const players = {
  me: [ME, ONYX], ghost: [2100001, ONYX], foxy: [2100002, ONYX], red: [2100003, ONYX],
  bonez: [2100004, VEX], smokey: [2100005, VEX], whiskers: [2100006, VEX],
  heist: [2100007, KOI], neon: [2100008, KOI], vito: [2100009, KOI],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const tokens = {};
for (const [who, [uid, fid]] of Object.entries(players)) {
  const key = `k${String(uid).padStart(7, '0')}${String(fid).padStart(8, '0')}`;
  tokens[who] = (await call(null, 'POST', '/v1/auth', { key, pageUserId: uid, showAvatar: true })).token;
}

const room = (who, input) => call(tokens[who], 'POST', '/v1/rooms', input);
const grant = (id, kind, target, label) => call(tokens.me, 'POST', `/v1/rooms/${id}/grants`, { kind, id: target, label });
const join = (who, id) => call(tokens[who], 'POST', `/v1/rooms/${id}/join`);
async function chat(id, lines) {
  for (const [who, text] of lines) {
    await call(tokens[who], 'POST', `/v1/rooms/${id}/messages`, { text });
    await sleep(1100); // under the 5-messages-per-5-seconds limit
  }
}

const war = await room('me', { name: 'War room: Koi Cartel', description: 'Targets, timings, call-outs', icon: 'assault', color: '#b22222' });
await grant(war.id, 'faction', ONYX, 'Onyx Syndicate');
for (const w of ['ghost', 'foxy', 'red']) await join(w, war.id);

const ally = await room('me', { name: 'Alliance HQ', description: 'Onyx + Vex coordination', icon: 'group', color: '#1565c0', showFactionTags: true });
await grant(ally.id, 'faction', ONYX, 'Onyx Syndicate');
await grant(ally.id, 'faction', VEX, 'Vex');
for (const w of ['red', 'foxy', 'bonez', 'smokey', 'whiskers']) await join(w, ally.id);

const trade = await room('me', { name: 'Trading Post', description: 'Buy, sell, price checks. No scams.', icon: 'trade', color: '#b8860b', visibility: 'public' });
const help = await room('me', { name: 'New Player Help', description: 'Ask anything, no stupid questions', icon: 'question', color: '#00838f', visibility: 'public' });
const news = await room('me', { name: 'Announcements', description: 'Torn Rooms news', icon: 'announcements', color: '#6a1b9a', visibility: 'public', postPolicy: 'admins' });
await room('me', { name: 'Racing', description: 'Races, cars, parts', icon: 'racing', color: '#2e7d32', visibility: 'public' });
for (const w of ['heist', 'neon', 'vito', 'whiskers', 'smokey']) await join(w, trade.id);
for (const w of ['neon', 'bonez']) await join(w, help.id);

await chat(news.id, [['me', 'Welcome to Torn Rooms! Public rooms are open to everyone; private rooms can be shared with players or whole factions. Be nice: admins can ban spammers.']]);

await chat(help.id, [
  ['neon', 'new here, what should I train first?'],
  ['bonez', 'Finish a few education courses, join a faction with a gym bonus, and train defense and dexterity early'],
  ['me', 'Also do the missions from Duke, good early money'],
  ['neon', 'thanks!!'],
]);

await chat(trade.id, [
  ['heist', 'Selling 50 Xanax @ 830k each, discount for 100+'],
  ['neon', 'Buying Erotic DVDs, paying 4.4m'],
  ['vito', 'PC: full plushie set, 18 pcs, asking 1.1m'],
  ['whiskers', 'anyone trading Feathery Hotel Coupons?'],
  ['smokey', 'Whiskers I have 3, mail me'],
]);

await chat(ally.id, [
  ['bonez', 'Koi are stacking for the war tomorrow, three of them bought xanax in bulk this morning'],
  ['red', 'We can lend you 4 hitters from 20:00 TCT'],
  ['smokey', 'Appreciated. Target list is in our forum thread'],
  ['whiskers', 'anyone got a spare blood bag? out of meds'],
  ['foxy', 'sent you 10'],
  ['me', 'Keep this room for coordination, chain chatter stays in your own war rooms'],
]);

await chat(war.id, [
  ['red', 'War starts 18:00 TCT, everyone online 10 min before pls'],
  ['ghost', 'Their top 5 are in hospital until 17:40, hitting the 2-3b stat guys first'],
  ['foxy', 'I have 4 xanax and 2 FHCs, can chain all evening'],
  ['me', "I'll call targets here. Don't hit anyone over 5b total stats"],
  ['red', 'Chain at 2,450. I take the 2,500 bonus hit'],
  ['ghost', 'hold hits, timer at 4:30'],
  ['foxy', 'go go go'],
]);

// An invitation waiting for you.
const peace = await room('vito', { name: 'Koi x Onyx peace talks', description: 'Leaders only', icon: 'star' });
await call(tokens.vito, 'POST', `/v1/rooms/${peace.id}/grants`, { kind: 'player', id: ME, label: 'you' });
await chat(peace.id, [['vito', 'Ceasefire after this war? 48 hours, no hits either side.']]);

console.log(JSON.stringify({ war: war.id, ally: ally.id, trade: trade.id, help: help.id, news: news.id, peace: peace.id }));
