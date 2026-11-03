# torn-rooms

Commits use the identity in this repo's local git config; do not change it. For GitHub commands use the `manuelcecchetto` account, scoped per command (`GH_TOKEN=$(gh auth token -u manuelcecchetto) gh ...`), since `gh`'s active account may be a different one.

Research notes: `research/FINDINGS.md`.

Searching: `userscript/src/generated/torn-chat.css` is one ~60 KB line; exclude it from repo-wide `rg` (`-g '!**/generated/torn-chat.css'`) or every match on a common word dumps the whole file.
