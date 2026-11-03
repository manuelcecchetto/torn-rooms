(() => {
  const clean = (el) => {
    const c = el.cloneNode(true);
    const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
    const texts = []; while (w.nextNode()) texts.push(w.currentNode);
    texts.forEach(t => { if (t.textContent.trim()) t.textContent = '{T' + t.textContent.trim().length + '}'; });
    c.querySelectorAll('a[href]').forEach(a => a.setAttribute('href', a.getAttribute('href').replace(/XID=\d+/, 'XID={ID}')));
    c.querySelectorAll('img').forEach(i => i.setAttribute('src', '{SRC}'));
    c.querySelectorAll('[id]').forEach(e => { if (/^[0-9a-f-]{36}:/.test(e.id)) e.id = '{MSGID}'; });
    return c.outerHTML;
  };
  const q = (s) => document.querySelector(s);
  const fac = q('#faction');
  const res = {};
  if (fac) {
    res.panelHeader = clean(fac.querySelector('[class*="root___RdBC0"]') || fac.firstElementChild);
    res.composer = clean(fac.querySelector('[class*="root___aBCjE"]'));
    const items = fac.querySelectorAll('[class*="virtualItem___"]');
    res.message = items.length ? clean(items[items.length-1]) : null;
    const ts = fac.querySelector('[class*="messageGroupTimestamp"]'); res.timestamp = ts ? clean(ts.parentElement) : null;
    res.panelShell = fac.outerHTML.length;
    res.footer = clean(fac.querySelector('[class*="footer___QxkWe"]'));
    res.newMsgs = fac.querySelector('[class*="up___UY0og"]') ? clean(fac.querySelector('[class*="up___UY0og"]')) : null;
  }
  const people = q('#people_panel'); if (people) { res.peopleHeader = clean(people.children[0]); res.peopleTabs = clean(people.children[1]); res.searchBox = clean(q('#private_chat_search_box')); const card = people.querySelector('button[id^="private_chat_card_"]'); res.card = card ? clean(card) : null; }
  const settings = q('#settings_panel'); if (settings) res.settings = clean(settings.children[1]);
  const bar = q('[class*="root___Ef1Ql"]'); if (bar) res.bar = clean(bar);
  const cs = (s) => { const e = q(s); if (!e) return null; const st = getComputedStyle(e); const r = e.getBoundingClientRect(); return {cls: e.className, pos: st.position, b: st.bottom, r: st.right, z: st.zIndex, disp: st.display, flex: st.flexDirection, gap: st.gap, rect: [r.x, r.y, r.width, r.height].map(Math.round)}; };
  res.layout = { chatRoot: cs('#chatRoot'), c1: cs('#chatRoot > div'), panels: cs('[class*="root___PF7AM"]'), bar: cs('[class*="root___Ef1Ql"]'), factionItem: cs('#faction'), vw: innerWidth, vh: innerHeight };
  return JSON.stringify(res);
})()
