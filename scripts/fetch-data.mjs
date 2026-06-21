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

async function findHighlightVideo(homeName, awayName) {
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
  // Relevance-only search can surface unrelated FIFA-channel uploads (training
  // clips, archive footage from other tournaments). Titles for this
  // tournament's match highlights consistently say "Highlights" and "2026",
  // so require both to avoid embedding the wrong match.
  const candidates = (searchJson.items ?? []).filter((item) => {
    if (!item.id?.videoId) return false;
    const title = (item.snippet?.title ?? "").toLowerCase();
    return title.includes("2026") && title.includes("highlight");
  });
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
    title: best.snippet?.title ?? null,
    durationSeconds: best.duration,
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
