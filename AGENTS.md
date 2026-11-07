# torn-rooms

Commits use the identity in this repo's local git config; do not change it. For GitHub commands use the `manuelcecchetto` account, scoped per command (`GH_TOKEN=$(gh auth token -u manuelcecchetto) gh ...`), since `gh`'s active account may be a different one.

Research notes: `research/FINDINGS.md`.

To send a build to the user's Windows PC: zip `dist/torn-rooms.user.js` (after `npm run build`) and Taildrop it to the Tailscale device `manuel`. The Mac App Store Tailscale is sandboxed and cannot read files by path, so pipe it: `/Applications/Tailscale.app/Contents/MacOS/Tailscale file cp --name torn-rooms-X.Y.Z.zip - manuel: < dist/torn-rooms-X.Y.Z.zip`.

Releases go out on Greasy Fork as script 603632 (https://greasyfork.org/scripts/603632), where the user's own Tampermonkey install comes from; there is no sync, each version is uploaded by hand: `npm run build`, push the commit (the script header points readers at the GitHub sources), then in the user's Chrome (signed in to Greasy Fork; ask them to sign in, never handle the password) open `/scripts/603632/versions/new`, put `dist/torn-rooms.user.js` into the `script_version_code` textarea and a line into `script_version_changelog`, and post. Through AppleScript `execute javascript` the 230 KB build must go in ~40 KB chunks (one call with all of it silently does nothing), and wrap each snippet in an IIFE: a top-level `const` from an earlier call makes the next one throw. Then the install link on the script page updates Tampermonkey. Port 8794 may already be taken by an old dev server, so check what a local URL serves before installing from it.

Deploy the Worker with `npx wrangler deploy --config worker/wrangler.jsonc` after the tests pass; the userscript and the Worker ship together when the protocol changes. If wrangler says the auth token expired, run `npx wrangler login` in the background (it opens the Cloudflare consent page in the user's browser and waits for **Allow** on localhost:8976), wait for "Successfully logged in", then deploy.
