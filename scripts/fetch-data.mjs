// Pulls live World Cup 2026 data from football-data.org and finds YouTube
// highlight videos for finished matches. Run by GitHub Actions on a cron
// schedule; writes JSON snapshots into /data that the static site reads.
import { readFile, writeFile, mkdir } from "node:fs/promises";

const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const COMPETITION = "WC"; // football-data.org code for FIFA World Cup
const API_FOOTBALL_LEAGUE_ID = 1; // FIFA World Cup
const API_FOOTBALL_SEASON = 2026;
const DATA_DIR = new URL("../data/", import.meta.url);

if (!FOOTBALL_DATA_API_KEY) {
  console.error("Missing FOOTBALL_DATA_API_KEY env var.");
  process.exit(1);
}

async function footballData(path) {
  const res = await fetch(`https://api.football-data.org/v4${path}`, {
    headers: { "X-Auth-Token": FOOTBALL_DATA_API_KEY },
  });
  if (!res.ok) {
    throw new Error(`football-data.org ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function readJsonIfExists(filename, fallback) {
  try {
    const text = await readFile(new URL(filename, DATA_DIR), "utf-8");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function writeJson(filename, data) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(new URL(filename, DATA_DIR), JSON.stringify(data, null, 2));
}

// ISO 8601 duration (e.g. "PT4M32S") -> seconds.
function parseIsoDuration(iso) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso ?? "");
  if (!match) return null;
  const [, h, m, s] = match;
  return (Number(h) || 0) * 3600 + (Number(m) || 0) * 60 + (Number(s) || 0);
}

const MAX_HIGHLIGHT_SECONDS = 5 * 60;
const MIN_HIGHLIGHT_SECONDS = 60; // excludes single-goal clips / Shorts, keeps "complete" reels
const FIFA_YOUTUBE_CHANNEL_ID = "UCpcTrCXblq78GZrTUTLWeBw"; // official "FIFA" channel

// The YouTube API returns titles with literal HTML entities (e.g.
// "Côte d&#39;Ivoire"), which would otherwise corrupt both the regex match
// below and the title text shown in the UI.
function decodeHtmlEntities(str) {
  return (str ?? "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// FIFA's official highlight uploads consistently follow this exact format:
// "Highlights | Team A 2-1 Team B | FIFA World Cup 2026™". Parsing the score
// and team names out of the title and cross-checking them against the real
// match lets us reject relevance-search false positives (training clips,
// archive footage, wrong fixture) instead of trusting keyword matches alone.
const TITLE_SCORE_RE = /highlights\s*\|\s*(.+?)\s+(\d+)\s*-\s*(\d+)\s+(.+?)\s*\|/i;

function titleMatchesMatch(title, homeName, awayName, homeScore, awayScore) {
  const match = TITLE_SCORE_RE.exec(decodeHtmlEntities(title));
  if (!match) return false;
  const [, t1, s1, s2, t2] = match;
  const teamsMatch = normalizeTeam(t1) === normalizeTeam(homeName) && normalizeTeam(t2) === normalizeTeam(awayName);
  if (!teamsMatch) return false;
  return Number(s1) === homeScore && Number(s2) === awayScore;
}

async function findHighlightVideo(homeName, awayName, homeScore, awayScore) {
  if (!YOUTUBE_API_KEY) return null;
  const query = `${homeName} vs ${awayName} highlights`;
  const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
  searchUrl.searchParams.set("part", "snippet");
  searchUrl.searchParams.set("type", "video");
  searchUrl.searchParams.set("channelId", FIFA_YOUTUBE_CHANNEL_ID);
  searchUrl.searchParams.set("maxResults", "5");
  searchUrl.searchParams.set("order", "relevance");
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("key", YOUTUBE_API_KEY);

  const searchRes = await fetch(searchUrl);
  if (!searchRes.ok) {
    console.warn(`YouTube search failed for "${query}": ${searchRes.status}`);
    return null;
  }
  const searchJson = await searchRes.json();
  const candidates = (searchJson.items ?? []).filter(
    (item) => item.id?.videoId && titleMatchesMatch(item.snippet?.title, homeName, awayName, homeScore, awayScore)
  );
  if (!candidates.length) return null;

  const detailsUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
  detailsUrl.searchParams.set("part", "contentDetails");
  detailsUrl.searchParams.set("id", candidates.map((c) => c.id.videoId).join(","));
  detailsUrl.searchParams.set("key", YOUTUBE_API_KEY);

  const detailsRes = await fetch(detailsUrl);
  if (!detailsRes.ok) {
    console.warn(`YouTube videos.list failed for "${query}": ${detailsRes.status}`);
    return null;
  }
  const detailsJson = await detailsRes.json();
  const durationById = new Map(
    (detailsJson.items ?? []).map((v) => [v.id, parseIsoDuration(v.contentDetails?.duration)])
  );

  // Prefer a "complete" highlight reel under 5 min: longest clip within the
  // [60s, 300s] band, since a single-goal clip or Short would be much shorter.
  const inBand = candidates
    .map((c) => ({ ...c, duration: durationById.get(c.id.videoId) }))
    .filter((c) => c.duration !== null && c.duration >= MIN_HIGHLIGHT_SECONDS && c.duration <= MAX_HIGHLIGHT_SECONDS)
    .sort((a, b) => b.duration - a.duration);

  const best = inBand[0];
  if (!best) return null;

  return {
    videoId: best.id.videoId,
    url: `https://www.youtube.com/watch?v=${best.id.videoId}`,
    title: decodeHtmlEntities(best.snippet?.title) || null,
    durationSeconds: best.duration,
  };
}

// football-data.org and API-Football name the same teams differently
// (e.g. "South Korea" vs "Korea Republic"). Normalize both sides so fixtures
// can be matched by team name + date.
const TEAM_ALIASES = {
  "south korea": "korea republic",
  "ivory coast": "cote d ivoire",
  "cote d'ivoire": "cote d ivoire",
  "cape verde islands": "cape verde",
  "cabo verde": "cape verde",
  usa: "united states",
  "ir iran": "iran",
  "congo dr": "dr congo",
  "dr congo": "dr congo",
  czechia: "czech republic",
  turkiye: "turkey",
};

function normalizeTeam(name) {
  const base = (name ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return TEAM_ALIASES[base] ?? base;
}

async function apiFootball(path) {
  const res = await fetch(`https://v3.football.api-sports.io${path}`, {
    headers: { "x-apisports-key": API_FOOTBALL_KEY },
  });
  if (!res.ok) {
    throw new Error(`api-football ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function buildFixtureIndex() {
  const json = await apiFootball(`/fixtures?league=${API_FOOTBALL_LEAGUE_ID}&season=${API_FOOTBALL_SEASON}`);
  const index = new Map();
  for (const item of json.response ?? []) {
    const dateKey = item.fixture.date.slice(0, 10);
    const key = `${dateKey}|${normalizeTeam(item.teams.home.name)}|${normalizeTeam(item.teams.away.name)}`;
    index.set(key, {
      fixtureId: item.fixture.id,
      homeTeamId: item.teams.home.id,
      awayTeamId: item.teams.away.id,
    });
  }
  return index;
}

function eventsForFixture(json, m, fixtureMeta) {
  const goals = [];
  const cards = [];
  for (const e of json.response ?? []) {
    const minute = e.time.extra ? `${e.time.elapsed}+${e.time.extra}'` : `${e.time.elapsed}'`;
    const side = e.team.id === fixtureMeta.homeTeamId ? "HOME" : "AWAY";
    if (e.type === "Goal") {
      goals.push({
        side,
        player: e.player.name,
        assist: e.assist?.name ?? null,
        minute,
        detail: e.detail,
      });
    } else if (e.type === "Card") {
      cards.push({
        side,
        player: e.player.name,
        minute,
        card: e.detail, // "Yellow Card" | "Red Card" | "Second Yellow card"
      });
    }
  }
  return { matchId: m.id, goals, cards };
}

async function main() {
  const [matchesResp, standingsResp, scorersResp] = await Promise.all([
    footballData(`/competitions/${COMPETITION}/matches`),
    footballData(`/competitions/${COMPETITION}/standings`),
    footballData(`/competitions/${COMPETITION}/scorers?limit=20`).catch((err) => {
      console.warn("Scorers endpoint unavailable on this API plan:", err.message);
      return null;
    }),
  ]);

  const matches = matchesResp.matches.map((m) => ({
    id: m.id,
    utcDate: m.utcDate,
    status: m.status,
    matchday: m.matchday,
    stage: m.stage,
    group: m.group,
    home: m.homeTeam.name,
    homeCrest: m.homeTeam.crest,
    away: m.awayTeam.name,
    awayCrest: m.awayTeam.crest,
    score: {
      home: m.score.fullTime.home,
      away: m.score.fullTime.away,
      winner: m.score.winner,
    },
  }));

  await writeJson("matches.json", {
    updatedAt: new Date().toISOString(),
    matches,
  });

  await writeJson("standings.json", {
    updatedAt: new Date().toISOString(),
    standings: standingsResp.standings,
  });

  if (scorersResp) {
    await writeJson("scorers.json", {
      updatedAt: new Date().toISOString(),
      scorers: scorersResp.scorers.map((s) => ({
        player: s.player.name,
        team: s.team.name,
        goals: s.goals,
        assists: s.assists,
        penalties: s.penalties,
      })),
    });
  }

  // Highlights: only search YouTube for finished matches we haven't cached yet,
  // to stay well within the YouTube Data API's daily quota.
  const highlightsCache = await readJsonIfExists("highlights.json", { videos: {} });
  const finished = matches.filter((m) => m.status === "FINISHED");
  for (const match of finished) {
    if (highlightsCache.videos[match.id]) continue;
    const video = await findHighlightVideo(match.home, match.away, match.score.home, match.score.away);
    if (video) highlightsCache.videos[match.id] = { ...video, matchId: match.id };
  }
  highlightsCache.updatedAt = new Date().toISOString();
  await writeJson("highlights.json", highlightsCache);

  // Match events (goal scorers, minutes, assists, cards): only fetch for
  // finished matches we haven't cached yet, since the free API-Football tier
  // is capped at 100 requests/day (1 fixtures-list call + 1 events call/match).
  const eventsCache = await readJsonIfExists("events.json", { matches: {} });
  if (API_FOOTBALL_KEY) {
    const uncached = finished.filter((m) => !eventsCache.matches[m.id]);
    if (uncached.length) {
      try {
        const fixtureIndex = await buildFixtureIndex();
        for (const m of uncached) {
          const dateKey = m.utcDate.slice(0, 10);
          const key = `${dateKey}|${normalizeTeam(m.home)}|${normalizeTeam(m.away)}`;
          const fixtureMeta = fixtureIndex.get(key);
          if (!fixtureMeta) {
            console.warn(`No API-Football fixture match for "${m.home} vs ${m.away}" on ${dateKey}`);
            continue;
          }
          const eventsJson = await apiFootball(`/fixtures/events?fixture=${fixtureMeta.fixtureId}`);
          eventsCache.matches[m.id] = eventsForFixture(eventsJson, m, fixtureMeta);
        }
      } catch (err) {
        console.warn("API-Football fetch failed:", err.message);
      }
    }
  }
  eventsCache.updatedAt = new Date().toISOString();
  await writeJson("events.json", eventsCache);

  console.log(`Done. ${matches.length} matches, ${finished.length} finished, ${Object.keys(highlightsCache.videos).length} highlights cached, ${Object.keys(eventsCache.matches).length} match events cached.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
