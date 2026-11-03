(() => {
  const out = [];
  const walk = (el, d) => {
    if (d > 40 || out.length > 1500) return;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).join('.') : '';
    const attrs = ['id','role','title','aria-label','type','placeholder','data-id','href'].map(a => el.getAttribute && el.getAttribute(a) != null ? `${a}=${JSON.stringify(String(el.getAttribute(a)).slice(0,40))}` : '').filter(Boolean).join(' ');
    const txt = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim()).map(n => n.textContent.trim().length).join(',');
    const st = el.getAttribute && el.getAttribute('style') ? ' style=' + JSON.stringify(el.getAttribute('style').slice(0,80)) : '';
    out.push('  '.repeat(d) + el.tagName.toLowerCase() + (cls ? '.' + cls : '') + (attrs ? ' [' + attrs + ']' : '') + st + (txt ? ' «text:' + txt + '»' : ''));
    for (const c of el.children) walk(c, d + 1);
  };
  walk(document.getElementById(window.__dumpId || 'chatRoot'), 0);
  return out.join('\n');
})()
