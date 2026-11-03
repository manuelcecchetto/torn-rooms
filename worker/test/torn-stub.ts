// Fake Torn API for tests. A key "k" + 15 digits of the form k<uid padded 7><fid padded 8>
// maps to that user and faction (fid 0 = no faction). "badkeybadkeybad1" is rejected. uid 666 is in federal jail.
export function stubIdentity(uid: number, fid: number): string {
  return `k${String(uid).padStart(7, '0')}${String(fid).padStart(8, '0')}`;
}

export async function tornStub(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.host !== 'torn.test') return new Response('blocked outbound ' + url.host, { status: 599 });
  const key = url.searchParams.get('key') ?? '';
  const m = /^k(\d{7})(\d{8})$/.exec(key);
  if (!m) return Response.json({ error: { code: 2, error: 'Incorrect key' } });
  const uid = Number(m[1]);
  const fid = Number(m[2]);
  if (url.pathname === '/v2/user/profile') return Response.json({ profile: { id: uid, name: `Player${uid}`, image: `https://avatars.torn.test/${uid}.png`, status: { state: uid === 666 ? 'Federal' : 'Okay' } } });
  if (url.pathname === '/v2/user/faction') return Response.json({ faction: fid ? { id: fid, name: `Faction${fid}`, tag: `F${fid}`, tag_image: '', position: 'Member', days_in_faction: 1 } : null });
  return Response.json({ error: { code: 9, error: 'unknown' } });
}
