# World Cup 2026 Monitor

A static site with four tabs — **Scores**, **Highlights**, **Player Stats**, **Tables** —
backed by JSON files in `/data` that a scheduled GitHub Action keeps refreshed.

## How it works (architecture)

```
GitHub Actions (cron, every 15 min)
   -> scripts/fetch-data.mjs
        - football-data.org API  -> matches, standings, top scorers
        - YouTube Data API       -> highlight video for each finished match
        - Wikipedia (scraped)    -> goal scorers/minutes, cards
   -> writes data/*.json
   -> commits + pushes to main
GitHub Pages (serves main branch root)
   -> index.html / app.js fetch data/*.json on every page load
```

No backend server is needed. The "scraping" you mentioned is replaced by hitting
real APIs (football-data.org for scores/tables/stats, YouTube Data API for
highlight links) — far more reliable than parsing HTML pages, and the data
arrives as clean JSON which is why everything here is plain HTML/CSS/JS rather
than scraped markup.

## One-time setup

### 1. API keys
- **football-data.org**: sign up free at https://www.football-data.org/client/register
  → copy your API token.
- **YouTube Data API**: in Google Cloud Console, enable "YouTube Data API v3"
  on a project, then create an API key under Credentials.
- Goal scorers/cards need no key — scraped from Wikipedia's match-report
  wikitext (see Notes below).

### 2. Create the GitHub repo
```bash
gh repo create world-cup-2026-monitor --public --source=. --remote=origin
git add -A
git commit -m "Initial World Cup 2026 monitor"
git push -u origin master
```
(If you don't have `gh`, create the repo on github.com and `git remote add origin <url>` instead.)

### 3. Add secrets
In the repo on GitHub: **Settings → Secrets and variables → Actions → New repository secret**
- `FOOTBALL_DATA_API_KEY`
- `YOUTUBE_API_KEY`

### 4. Enable GitHub Pages
**Settings → Pages → Build and deployment → Source: Deploy from a branch**,
branch `master` (or `main`), folder `/ (root)`. Save — GitHub gives you a live URL.

### 5. Run the workflow once
**Actions tab → "Update World Cup data" → Run workflow** (or just wait for the
15-minute cron). This populates `data/*.json` for the first time and pushes
the commit, which triggers Pages to redeploy automatically.

## Local development
```bash
FOOTBALL_DATA_API_KEY=xxx YOUTUBE_API_KEY=yyy node scripts/fetch-data.mjs
# then open index.html via a local server, e.g.:
npx serve .
```

## Notes
- `data/highlights.json` is a cache: once a finished match has a video, the
  script won't re-search YouTube for it, to stay within the free daily quota
  (100 search queries/day on the default quota).
- The top-scorers endpoint may return 403 on football-data.org's free tier for
  some competitions — if so, `scorers.json` simply stays empty and the Stats
  tab shows a friendly empty state instead of failing the whole pipeline.
- `data/events.json` (goal scorers/minutes, cards) is scraped from Wikipedia's
  group-stage and knockout-stage match-report wikitext — there's no API for
  this data on a free tier for the current season. It's matched to a match by
  date + FIFA team code, so it's only as reliable as Wikipedia's current
  template format and how quickly editors add the lineup/cards section after
  a match. Treat it as best-effort: it may lag behind the result or stay
  empty for a match if the page format doesn't parse cleanly.
- Cron schedule lives in `.github/workflows/update-data.yml` — adjust
  `*/15 * * * *` if you want a different refresh cadence.
