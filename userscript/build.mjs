// Bundles the userscript into dist/torn-rooms.user.js.
//   TR_API_BASE=http://127.0.0.1:8787 node userscript/build.mjs   (local server)
//   node userscript/build.mjs                                      (production server)
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const apiBase = (process.env.TR_API_BASE ?? 'https://torn-rooms.manuel-cecchetto99.workers.dev').replace(/\/$/, '');
const dev = apiBase.startsWith('http://');
const host = new URL(apiBase).hostname;
const updateUrl = process.env.TR_UPDATE_URL;
const buildId = `${pkg.version}${dev ? `.${Math.floor(Date.now() / 1000)}` : ''}`;

const header = `// ==UserScript==
// @name         Torn Rooms${dev ? ' (dev)' : ''}
// @namespace    torn-rooms
// @version      ${buildId}
// @description  Extra chat rooms in Torn's chat: invite players and whole factions, war rooms, public topic rooms.
// @match        https://www.torn.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      ${host}
// @connect      api.torn.com
${updateUrl ? `// @updateURL    ${updateUrl}\n// @downloadURL  ${updateUrl}\n` : ''}// ==/UserScript==
`;

await build({
  entryPoints: ['userscript/src/main.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  outfile: 'dist/torn-rooms.user.js',
  loader: { '.css': 'text', '.jpg': 'dataurl' },
  define: { __API_BASE__: JSON.stringify(apiBase), __VERSION__: JSON.stringify(buildId) },
  banner: { js: header },
  legalComments: 'none',
  logLevel: 'info',
});
