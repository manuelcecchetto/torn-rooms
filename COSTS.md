# Running costs

Prices: Cloudflare Workers and Durable Objects pricing pages, checked 2026-11-03
(developers.cloudflare.com/workers/platform/pricing, /durable-objects/platform/pricing).
The Torn API is free. A `*.workers.dev` URL is free; a custom domain is optional.

## What one player costs

Measured on the local stack (`wrangler dev` request log), not guessed:

| Action | Worker requests | Durable Object requests |
|---|---:|---:|
| Torn page load (stream + room list + open rooms' history, via the `hello` event) | 1 | 1 |
| Send a message | 1 | 1 |
| Read a room (debounced) | 1 | 1 |
| Log in (every 6 hours, plus 2 Torn API calls) | 1 | 1 |
| Open a sub-view (members, invite, browse) | 1 | 1 |

Every Worker request makes exactly one call to the Durable Object, and Cloudflare bills each
call as one Durable Object request. So the two counts are always equal.

**Assumption (not measured):** an active player loads about 500 Torn pages a day and sends
or reads about 60 times, which comes to **~570 requests a day**, or ~17,000 a month. Heavy
chainers and war players can load 2,000+ pages a day, so treat the player counts below as
rough, within a factor of 2-3.

Page loads dominate, which is why a page load costs one request: the stream's first event
carries the room list and history. Without that it was 3 requests a page.

## Plans

**Free plan:** 100,000 Worker requests a day and 100,000 Durable Object requests a day, plus
13,000 GB-s of Durable Object duration a day, 5 M SQLite rows read and 100 k rows written a
day, and 5 GB storage. Going over a limit makes further calls **fail** until 00:00 UTC, which
is midnight Torn time. That is fine for testing, but not for a public launch.

**Workers Paid, $5/month:** 10 M Worker requests a month (then $0.30/M) and 1 M Durable
Object requests a month (then $0.15/M). Also included: 400 k GB-s duration (then $12.50/M
GB-s), 25 B rows read, 50 M rows written (then $1.00/M) and 5 GB storage (then $0.20/GB-month).
Billable usage rounds up to the next million.

## Estimates

| Active players | Requests a month (each kind) | Free plan | Workers Paid |
|---:|---:|---|---:|
| 50 | 0.9 M | fits (~29 k a day) | $5.00 |
| 150 | 2.6 M | right at the 100 k/day limit | $5.30 |
| 1,000 | 17 M | no | ~$10 ($5 + $2.40 Workers + $2.55 DO) |
| 5,000 | 85 M | no | ~$41 ($5 + $22.80 Workers + $12.75 DO) |

The other meters stay inside the included amounts at these sizes:

- **Duration:** all rooms live in one Durable Object. It is billed while any stream is open,
  at 128 MB, whatever the number of players. Even if it never sleeps, that is
  0.125 GB × 2.6 M s ≈ 324 k GB-s a month (10,800 a day). That is under the free 13,000 a
  day and the paid 400 k a month.
- **Rows written:** a message writes about 5 rows (message, its index, room, membership).
  5,000 players × 30 messages a day, plus read marks, comes to ~27 M rows a month, under the 50 M included.
  On the free plan, 100 k rows a day caps it at roughly 15-20 k messages a day.
- **Storage:** each room keeps its last 5,000 messages, about 1.5 MB. 1,000 rooms is about
  1.5 GB, under 5 GB.
- **CPU:** requests take a few ms of CPU each, well under the 30 M ms included.

## Limits before cost

One Durable Object handles roughly 1,000 requests a second. 5,000 players is ~33 requests a
second on average, so there is headroom even at peaks 10 times that. Past that, shard by room
(one object per room) before cost becomes a concern. Message fan-out loops over all open
streams, which is fine up to a few thousand concurrent tabs.

## Recommendation

Use the free plan while testing with friends and your faction. Before posting the public rooms
on the forums, switch to Workers Paid ($5/month). At realistic Torn adoption (hundreds to a
couple of thousand players) the bill stays between $5 and $15 a month.
