# torn-rooms

Commits use the identity in this repo's local git config; do not change it. For GitHub commands use the `manuelcecchetto` account, scoped per command (`GH_TOKEN=$(gh auth token -u manuelcecchetto) gh ...`), since `gh`'s active account may be a different one.

Research notes: `research/FINDINGS.md`.

To send a build to the user's Windows PC: zip `dist/torn-rooms.user.js` (after `npm run build`) and Taildrop it to the Tailscale device `manuel`. The Mac App Store Tailscale is sandboxed and cannot read files by path, so pipe it: `/Applications/Tailscale.app/Contents/MacOS/Tailscale file cp --name torn-rooms-X.Y.Z.zip - manuel: < dist/torn-rooms-X.Y.Z.zip`.
