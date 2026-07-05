# Channtasy Cup 🏆

A static leaderboard for the Channtasy Cup — a private FIFA World Cup 2026 **Second Chance**
knockout bracket pool. Participants' picks are stored as JSON; the leaderboard recomputes scores
in the browser as real match results come in. Hosted on GitHub Pages (custom domain
`channtasycup.com` to be added later).

## How it works

- `index.html` + `assets/style.css` + `assets/app.js` — the page. `app.js` loads the JSON below,
  works out which teams have actually reached each round, scores every bracket, and renders the
  ranked board. No build step, no server.
- `data/bracket.json` — the fixed knockout skeleton (teams, fixtures, topology). Doesn't change.
- `data/picks.json` — every participant's bracket. The roster lives here too; people without a
  submitted bracket have `"hasBracket": false` and show under "Awaiting brackets".
- `data/results.json` — actual match outcomes, keyed by match id. **This is the file you update.**
- `data/scoring.json` — the official FIFA point values.

## Scoring

Per team correctly predicted to **reach** a round (advancement-based, independent per round):

| Reached… | Points |
|---|--:|
| Round of 16 | 20 |
| Quarter-Finals | 30 |
| Semi-Finals | 40 |
| Final | 75 |
| Champion | 100 |

Max possible = 970.

## Updating results after a game

Match ids: `M1`–`M16` = Round of 32, `A1`–`D2` = Round of 16, `QA`–`QD` = Quarter-Finals,
`S1`/`S2` = Semi-Finals, `F` = Final. (See `data/bracket.json` for which fixture each id is.)

**Option A — hand-edit (simplest, always works).** Add the winning team's 3-letter code to
`data/results.json`:

```json
{
  "lastUpdated": "2026-06-30",
  "matchResults": { "M3": "CAN", "M1": "GER", "M9": "BRA" }
}
```

Commit and push — the leaderboard updates on the next Pages build (~1 minute).

**Option B — fetch script.** Pulls finished knockout games from a public API and proposes updates:

```bash
node scripts/fetch-results.mjs           # dry run — shows what it would change
node scripts/fetch-results.mjs --write    # apply to data/results.json
```

It never overwrites results you've already entered (use `--force` to re-decide) and only fills a
match when both teams are known and a finished source game for that pairing is found. The source can
lag or miss penalty shootouts, so hand-editing is the source of truth.

## Adding a participant's bracket

In `data/picks.json`, set their `hasBracket` to `true` and fill `r16` (their 16 R32-match winners),
`qf` (8), `sf` (4), `final` (2), and `champion`. See an existing entry for the shape.

## Run locally

```bash
python3 -m http.server 8000   # then open http://localhost:8000/
```

(Open via a server, not `file://` — the page fetches the JSON files.)

## Deploy

Push to GitHub, then Settings → Pages → deploy from `main` / root. To use `channtasycup.com` later,
add a `CNAME` file containing the domain and point DNS at GitHub Pages.
