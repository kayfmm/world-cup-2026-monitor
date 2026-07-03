const tabButtons = document.querySelectorAll(".tab-btn");
const tabPanels = document.querySelectorAll(".tab-panel");

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    tabButtons.forEach((b) => b.classList.remove("active"));
    tabPanels.forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
  });
});

async function loadJson(path) {
  try {
    const res = await fetch(`data/${path}?t=${Date.now()}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(iso) {
  return new Date(iso).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

const STAGE_LABELS = {
  GROUP_STAGE: "Group Stage",
  LAST_32: "Round of 32",
  LAST_16: "Round of 16",
  QUARTER_FINALS: "Quarterfinals",
  SEMI_FINALS: "Semifinals",
  THIRD_PLACE: "Third Place",
  FINAL: "Final",
};

function stageLabel(m) {
  return STAGE_LABELS[m.stage] ?? m.stage?.replace(/_/g, " ") ?? "";
}

function teamName(name) {
  return name ?? "TBD";
}

function groupByDay(matches) {
  const map = new Map();
  for (const m of matches) {
    const key = new Date(m.utcDate).toDateString();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(m);
  }
  return map;
}

function cardIcon(card) {
  return /red|second yellow/i.test(card) ? "🟥" : "🟨";
}

function matchDetails(events) {
  if (!events || (!events.goals.length && !events.cards.length)) return "";

  const goalLine = (g) =>
    `<div class="detail-line">⚽ ${g.player} <span class="detail-minute">${g.minute}</span>${
      g.assist ? `<span class="detail-assist">assist: ${g.assist}</span>` : ""
    }</div>`;
  const cardLine = (c) =>
    `<div class="detail-line">${cardIcon(c.card)} ${c.player} <span class="detail-minute">${c.minute}</span></div>`;

  const homeGoals = events.goals.filter((g) => g.side === "HOME").map(goalLine).join("");
  const awayGoals = events.goals.filter((g) => g.side === "AWAY").map(goalLine).join("");
  const cards = events.cards.map(cardLine).join("");

  return `
    <div class="match-details">
      <div class="match-details-col">${homeGoals}</div>
      <div class="match-details-col">${awayGoals}</div>
    </div>
    ${cards ? `<div class="match-cards">${cards}</div>` : ""}`;
}

// FIFA's own site search is a JS-rendered SPA that doesn't return usable
// results from a direct link, so a Google search scoped to fifa.com is a
// more reliable way to surface FIFA's own pages for the same query.
function fifaSearchUrl(m) {
  return `https://www.google.com/search?q=${encodeURIComponent(`site:fifa.com ${m.home} vs ${m.away}`)}`;
}

// Crest-pair "thumbnail" for the FIFA search link, kept consistent across
// every match instead of mixing in YouTube's own branded thumbnail images.
function fallbackThumb(m) {
  return `
    <div class="thumb-placeholder">
      ${m.homeCrest ? `<img class="thumb-crest" src="${m.homeCrest}" alt="" />` : ""}
      <span class="thumb-vs">vs</span>
      ${m.awayCrest ? `<img class="thumb-crest" src="${m.awayCrest}" alt="" />` : ""}
    </div>`;
}

function matchCard(m, events) {
  const isLive = m.status === "IN_PLAY" || m.status === "PAUSED";
  const isFinished = m.status === "FINISHED";
  const homeWin = m.score.winner === "HOME_TEAM";
  const awayWin = m.score.winner === "AWAY_TEAM";

  // Use regularTime scores when available (extra time / penalty matches),
  // otherwise fall back to fullTime (regular 90-min matches).
  const isPens = m.score.duration === "PENALTY_SHOOTOUT";
  const isAET = m.score.duration === "EXTRA_TIME";
  const displayHome = isPens || isAET
    ? (m.score.regularTime?.home ?? m.score.home)
    : m.score.home;
  const displayAway = isPens || isAET
    ? (m.score.regularTime?.away ?? m.score.away)
    : m.score.away;
  const hasScore = displayHome !== null && displayAway !== null;

  const pensScore = isPens && m.score.penalties?.home !== null
    ? `<span class="pens-badge">Pens (${m.score.penalties.home}–${m.score.penalties.away})</span>`
    : "";
  const aetBadge = isAET ? `<span class="aet-badge">AET</span>` : "";

  const thumbHtml = isFinished
    ? `<a class="inline-thumb" href="${fifaSearchUrl(m)}" target="_blank" rel="noopener" title="Search FIFA for highlights">
        ${fallbackThumb(m)}
      </a>`
    : "";

  return `
    <div class="match-box">
      <div class="match-box-label">${m.group ? m.group.replace("GROUP_", "Group ") : stageLabel(m)}</div>
      <div class="match-box-body">
        <div class="match-box-teams">
          <div class="match-row ${homeWin ? "winner" : ""}">
            ${m.homeCrest ? `<img class="crest" src="${m.homeCrest}" alt="" />` : `<span class="crest crest-placeholder"></span>`}
            <span class="team-name">${teamName(m.home)}</span>
            <span class="team-score">${hasScore ? displayHome : ""}</span>
          </div>
          <div class="match-row ${awayWin ? "winner" : ""}">
            ${m.awayCrest ? `<img class="crest" src="${m.awayCrest}" alt="" />` : `<span class="crest crest-placeholder"></span>`}
            <span class="team-name">${teamName(m.away)}</span>
            <span class="team-score">${hasScore ? displayAway : ""}</span>
          </div>
        </div>
        <div class="match-box-meta">
          <span class="status-badge ${isLive ? "live" : ""}">${isLive ? "LIVE" : isFinished ? "FT" : fmtTime(m.utcDate)}</span>
          ${aetBadge}${pensScore}
          ${thumbHtml}
        </div>
      </div>
      ${matchDetails(events)}
    </div>`;
}

function renderScores(matchesData, eventsData) {
  const el = document.getElementById("scores-list");
  const matches = matchesData?.matches ?? [];
  const eventsByMatch = eventsData?.matches ?? {};
  const results = matches.filter((m) => m.status === "FINISHED");

  if (!results.length) {
    el.textContent = "No results yet — check back once matches have been played.";
    return;
  }

  const sorted = [...results].sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate));
  const dayGroups = groupByDay(sorted);

  el.innerHTML = [...dayGroups.entries()]
    .map(([dayKey, dayMatches]) => `
      <section class="day-group">
        <div class="day-heading">${stageLabel(dayMatches[0])} &middot; ${dayLabel(dayMatches[0].utcDate)}</div>
        <div class="match-grid">${dayMatches.map((m) => matchCard(m, eventsByMatch[m.id])).join("")}</div>
      </section>`)
    .join("");
}

function upcomingCard(m) {
  return `
    <div class="match-box">
      <div class="match-box-label">${m.group ? m.group.replace("GROUP_", "Group ") : stageLabel(m)}</div>
      <div class="match-box-body">
        <div class="match-box-teams">
          <div class="match-row">
            ${m.homeCrest ? `<img class="crest" src="${m.homeCrest}" alt="" />` : `<span class="crest crest-placeholder"></span>`}
            <span class="team-name">${teamName(m.home)}</span>
          </div>
          <div class="match-row">
            ${m.awayCrest ? `<img class="crest" src="${m.awayCrest}" alt="" />` : `<span class="crest crest-placeholder"></span>`}
            <span class="team-name">${teamName(m.away)}</span>
          </div>
        </div>
        <div class="match-box-meta">
          <span class="kickoff-time">${fmtTime(m.utcDate)}</span>
        </div>
      </div>
    </div>`;
}

function renderUpcoming(matchesData) {
  const el = document.getElementById("upcoming-list");
  const matches = matchesData?.matches ?? [];
  const now = Date.now();
  const cutoff = now + 2 * 24 * 60 * 60 * 1000;

  const upcoming = matches.filter((m) => {
    const t = new Date(m.utcDate).getTime();
    return (m.status === "TIMED" || m.status === "SCHEDULED") && t >= now && t <= cutoff;
  });

  if (!upcoming.length) {
    el.textContent = "No matches scheduled in the next 48 hours.";
    return;
  }

  const sorted = [...upcoming].sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));
  const dayGroups = groupByDay(sorted);

  el.innerHTML = [...dayGroups.entries()]
    .map(([dayKey, dayMatches]) => `
      <section class="day-group">
        <div class="day-heading">${stageLabel(dayMatches[0])} &middot; ${dayLabel(dayMatches[0].utcDate)}</div>
        <div class="match-grid">${dayMatches.map((m) => upcomingCard(m)).join("")}</div>
      </section>`)
    .join("");
}

function renderStats(scorersData) {
  const tbody = document.querySelector("#stats-table tbody");
  const scorers = scorersData?.scorers ?? [];
  if (!scorers.length) {
    tbody.innerHTML = `<tr><td colspan="5">No player stats available yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = scorers
    .map(
      (s) => `<tr><td>${s.player}</td><td>${s.team}</td><td>${s.goals ?? 0}</td><td>${s.assists ?? 0}</td><td>${s.penalties ?? 0}</td></tr>`
    )
    .join("");
}

function renderTables(standingsData) {
  const el = document.getElementById("standings-groups");
  const groups = standingsData?.standings ?? [];
  if (!groups.length) {
    el.textContent = "No standings available yet.";
    return;
  }
  el.innerHTML = groups
    .map((g) => {
      const rows = g.table
        .map(
          (t) => `
          <tr>
            <td>${t.position}</td>
            <td>${t.team.name}</td>
            <td>${t.playedGames}</td>
            <td>${t.won}</td>
            <td>${t.draw}</td>
            <td>${t.lost}</td>
            <td>${t.goalDifference}</td>
            <td>${t.points}</td>
          </tr>`
        )
        .join("");
      return `
        <h3 class="group-title">${g.group ?? g.stage ?? "Group"}</h3>
        <table>
          <thead><tr><th>#</th><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    })
    .join("");
}

async function init() {
  const [matchesData, scorersData, standingsData, eventsData] = await Promise.all([
    loadJson("matches.json"),
    loadJson("scorers.json"),
    loadJson("standings.json"),
    loadJson("events.json"),
  ]);

  renderScores(matchesData, eventsData);
  renderUpcoming(matchesData);
  renderStats(scorersData);
  renderTables(standingsData);

  const updatedAt = matchesData?.updatedAt;
  document.getElementById("last-updated").textContent = updatedAt
    ? `Last updated: ${fmtDate(updatedAt)}`
    : "";
}

init();
