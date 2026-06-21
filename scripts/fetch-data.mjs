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

// football-data.org and FIFA's YouTube channel name the same teams
// differently (e.g. "South Korea" vs "Korea Republic"). Normalize both sides
// so highlight titles can be matched against the real match.
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

// API-Football's free tier blocks the current (2026) season entirely, so
// goal/card events are scraped from Wikipedia's match-report wikitext
// instead, which is freely available and kept reasonably up to date by
// editors during the tournament. This is inherently best-effort: it depends
// on Wikipedia's current template format and may lag behind live results or
// occasionally miss a match if a page's formatting differs.
const WIKI_USER_AGENT = "WorldCup2026Monitor/1.0 (https://github.com/kayfmm/world-cup-2026-monitor)";
const WIKI_GROUP_PAGES = "ABCDEFGHIJKL".split("").map((g) => `2026_FIFA_World_Cup_Group_${g}`);
const WIKI_KNOCKOUT_PAGE = "2026_FIFA_World_Cup_knockout_stage";

async function fetchWikitext(title) {
  const url = new URL("https://en.wikipedia.org/w/api.php");
  url.searchParams.set("action", "parse");
  url.searchParams.set("page", title);
  url.searchParams.set("prop", "wikitext");
  url.searchParams.set("format", "json");
  const res = await fetch(url, { headers: { "User-Agent": WIKI_USER_AGENT } });
  if (!res.ok) {
    console.warn(`Wikipedia fetch failed for "${title}": ${res.status}`);
    return null;
  }
  const json = await res.json();
  return json.parse?.wikitext?.["*"] ?? null;
}

// Splits a page's wikitext into per-match chunks: the {{#invoke:football
// box|main ...}} block (balancing nested template braces) plus the
// following lineup section, which is where card info lives.
function extractFootballBoxes(wikitext) {
  const boxes = [];
  const marker = "{{#invoke:football box|main";
  let searchFrom = 0;
  while (true) {
    const start = wikitext.indexOf(marker, searchFrom);
    if (start === -1) break;
    let depth = 0;
    let i = start;
    for (; i < wikitext.length; i++) {
      if (wikitext.startsWith("{{", i)) {
        depth++;
        i++;
      } else if (wikitext.startsWith("}}", i)) {
        depth--;
        i++;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    const boxText = wikitext.slice(start, i);
    const nextStart = wikitext.indexOf(marker, i);
    const lineupEnd = Math.min(wikitext.length, i + 8000, nextStart === -1 ? Infinity : nextStart);
    boxes.push({ boxText, lineupText: wikitext.slice(i, lineupEnd) });
    searchFrom = i;
  }
  return boxes;
}

function parseGoals(block) {
  if (!block) return [];
  const goals = [];
  const lineRe = /\*\s*\[\[(?:[^\]|]+\|)?([^\]]+)\]\]\s*((?:\d+(?:\+\d+)?'(?:\s*\([^)]*\))?,?\s*)+)/g;
  let line;
  while ((line = lineRe.exec(block))) {
    const player = line[1].trim();
    const minuteRe = /(\d+(?:\+\d+)?)'(?:\s*\(([^)]*)\))?/g;
    let minute;
    while ((minute = minuteRe.exec(line[2]))) {
      goals.push({ player, minute: `${minute[1]}'`, detail: minute[2] ?? null });
    }
  }
  return goals;
}

function parseBoxMeta(boxText) {
  const team1Match = /\|team1=\{\{#invoke:flag\|[^|]+\|([A-Za-z]{2,4})/.exec(boxText);
  const team2Match = /\|team2=\{\{#invoke:flag\|[^|]+\|([A-Za-z]{2,4})/.exec(boxText);
  const goals1Match = /\|goals1=([\s\S]*?)\n\|goals2=/.exec(boxText);
  const goals2Match = /\|goals2=([\s\S]*?)\n\|(?:stadium|attendance|referee|report|man_of_the_match|extratime)/.exec(boxText);
  if (!team1Match || !team2Match) return null;
  return {
    homeCode: team1Match[1].toUpperCase(),
    awayCode: team2Match[1].toUpperCase(),
    goals1: parseGoals(goals1Match?.[1]),
    goals2: parseGoals(goals2Match?.[1]),
  };
}

// Wikipedia's lineup section has two inner wikitables, home XI then away XI,
// each opened with this same tag (the outer cell's width attribute varies —
// "40%" vs "50%" — depending on whether a pitch-map image sits between
// them, so splitting on the inner table's own consistent opening tag is what
// reliably separates the two). Cards are {{yel|<minute>}} /
// {{sent off|<count>|<minute>}} templates on the same row as the player.
function parseCards(lineupText) {
  const parts = lineupText.split('{| style="font-size:90%');
  const homeHalf = parts[1] ?? "";
  const awayHalf = parts[2] ?? "";

  function cardsFromHalf(half) {
    const cards = [];
    for (const row of half.split("|-")) {
      const nameMatch = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(row);
      if (!nameMatch) continue;
      const player = (nameMatch[2] ?? nameMatch[1]).replace(/\s*\(footballer[^)]*\)/, "").trim();
      const sentOff = /\{\{sent off\|(\d+)\|([^}]+)\}\}/.exec(row);
      const yel = /\{\{yel\|([^}]+)\}\}/.exec(row);
      if (sentOff) {
        cards.push({ player, minute: `${sentOff[2]}'`, card: sentOff[1] === "0" ? "Red Card" : "Second Yellow Card" });
      } else if (yel) {
        cards.push({ player, minute: `${yel[1]}'`, card: "Yellow Card" });
      }
    }
    return cards;
  }

  return { homeCards: cardsFromHalf(homeHalf), awayCards: cardsFromHalf(awayHalf) };
}

async function scrapeWikipediaEvents(finishedMatches) {
  // Matched by team-code pair alone, not date: Wikipedia's "date=" is the
  // local kickoff date while football-data.org's utcDate is UTC, and these
  // disagree for late-night-UTC matches. Each team pair only meets once in
  // group or knockout play, so the pair alone is an unambiguous key.
  const matchIndex = new Map();
  for (const m of finishedMatches) {
    if (!m.homeTla || !m.awayTla) continue;
    matchIndex.set(`${m.homeTla}|${m.awayTla}`, m);
  }

  const results = new Map();
  for (const title of [...WIKI_GROUP_PAGES, WIKI_KNOCKOUT_PAGE]) {
    const wikitext = await fetchWikitext(title);
    if (!wikitext) continue;
    for (const { boxText, lineupText } of extractFootballBoxes(wikitext)) {
      const meta = parseBoxMeta(boxText);
      if (!meta) continue;
      const match = matchIndex.get(`${meta.homeCode}|${meta.awayCode}`);
      if (!match) continue;
      const { homeCards, awayCards } = parseCards(lineupText);
      results.set(match.id, {
        matchId: match.id,
        goals: [
          ...meta.goals1.map((g) => ({ ...g, side: "HOME" })),
          ...meta.goals2.map((g) => ({ ...g, side: "AWAY" })),
        ],
        cards: [
          ...homeCards.map((c) => ({ ...c, side: "HOME" })),
          ...awayCards.map((c) => ({ ...c, side: "AWAY" })),
        ],
      });
    }
  }
  return results;
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
    homeTla: m.homeTeam.tla,
    away: m.awayTeam.name,
    awayCrest: m.awayTeam.crest,
    awayTla: m.awayTeam.tla,
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

  // Match events (goal scorers, minutes, assists, cards): scraped from
  // Wikipedia's match-report wikitext (see scrapeWikipediaEvents). Only hit
  // Wikipedia when there's actually a finished match we haven't cached yet.
  const eventsCache = await readJsonIfExists("events.json", { matches: {} });
  const uncachedFinished = finished.filter((m) => !eventsCache.matches[m.id]);
  if (uncachedFinished.length) {
    try {
      const scraped = await scrapeWikipediaEvents(finished);
      for (const [matchId, events] of scraped) {
        eventsCache.matches[matchId] = events;
      }
    } catch (err) {
      console.warn("Wikipedia events scrape failed:", err.message);
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
