// Pulls live World Cup 2026 data from football-data.org and finds YouTube
// highlight videos for finished matches. Run by GitHub Actions on a cron
// schedule; writes JSON snapshots into /data that the static site reads.
import { readFile, writeFile, mkdir } from "node:fs/promises";

const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const COMPETITION = "WC"; // football-data.org code for FIFA World Cup
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

async function findHighlightVideo(homeName, awayName) {
  if (!YOUTUBE_API_KEY) return null;
  const query = `${homeName} vs ${awayName} highlights FIFA World Cup 2026`;
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("maxResults", "1");
  url.searchParams.set("order", "relevance");
  url.searchParams.set("q", query);
  url.searchParams.set("key", YOUTUBE_API_KEY);

  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`YouTube search failed for "${query}": ${res.status}`);
    return null;
  }
  const json = await res.json();
  const videoId = json.items?.[0]?.id?.videoId;
  if (!videoId) return null;
  return {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: json.items[0].snippet?.title ?? null,
  };
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
    const video = await findHighlightVideo(match.home, match.away);
    if (video) highlightsCache.videos[match.id] = { ...video, matchId: match.id };
  }
  highlightsCache.updatedAt = new Date().toISOString();
  await writeJson("highlights.json", highlightsCache);

  console.log(`Done. ${matches.length} matches, ${finished.length} finished, ${Object.keys(highlightsCache.videos).length} highlights cached.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
