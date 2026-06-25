// Pulls live World Cup 2026 data from football-data.org and scrapes
// Wikipedia for goal/card events. Run by GitHub Actions on a cron schedule;
// writes JSON snapshots into /data that the static site reads.
import { readFile, writeFile, mkdir } from "node:fs/promises";

const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY;
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

  const finished = matches.filter((m) => m.status === "FINISHED");

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

  console.log(`Done. ${matches.length} matches, ${finished.length} finished, ${Object.keys(eventsCache.matches).length} match events cached.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
