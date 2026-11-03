#!/bin/sh
# Rebuild the dev userscript, open it in Chrome so Tampermonkey offers the update, then confirm it.
set -e
cd "$(dirname "$0")/.."
node tools/extract-css.mjs >/dev/null  # new Torn classes in the source need their copied CSS
TR_API_BASE=http://127.0.0.1:8788 TR_UPDATE_URL=http://127.0.0.1:8793/torn-rooms.user.js node userscript/build.mjs >/dev/null 2>&1
sed -n 's#^// @version *##p' dist/torn-rooms.user.js | head -1
osascript -e 'tell application "Google Chrome" to tell front window to make new tab with properties {URL:"http://127.0.0.1:8793/torn-rooms.user.js"}' >/dev/null
