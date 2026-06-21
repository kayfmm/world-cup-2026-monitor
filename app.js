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

function embedPlayer(videoId) {
  return `<iframe src="https://www.youtube.com/embed/${videoId}?autoplay=1" title="Match highlights" frameborder="0" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
}

document.addEventListener("click", (e) => {
  const trigger = e.target.closest("[data-video-id]");
  if (!trigger) return;
  e.preventDefault();
  const container = trigger.closest(".inline-thumb, .highlight-thumb");
  if (container) container.outerHTML = embedPlayer(trigger.dataset.videoId);
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

function matchCard(m, video) {
  const isLive = m.status === "IN_PLAY" || m.status === "PAUSED";
  const isFinished = m.status === "FINISHED";
  const hasScore = m.score.home !== null && m.score.away !== null;
  const homeWin = m.score.winner === "HOME_TEAM";
  const awayWin = m.score.winner === "AWAY_TEAM";
  const thumbHtml = isFinished && video
    ? `<button class="inline-thumb" data-video-id="${video.videoId}" title="Play highlights">
        <img src="https://img.youtube.com/vi/${video.videoId}/mqdefault.jpg" alt="" loading="lazy" />
        <span class="play-badge">▶</span>
      </button>`
    : isFinished
      ? `<a class="inline-thumb" href="https://www.youtube.com/results?search_query=${encodeURIComponent(`${m.home} vs ${m.away} highlights FIFA World Cup 2026`)}" target="_blank" rel="noopener">
          <span class="thumb-placeholder">🔍</span>
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
            <span class="team-score">${hasScore ? m.score.home : ""}</span>
          </div>
          <div class="match-row ${awayWin ? "winner" : ""}">
            ${m.awayCrest ? `<img class="crest" src="${m.awayCrest}" alt="" />` : `<span class="crest crest-placeholder"></span>`}
            <span class="team-name">${teamName(m.away)}</span>
            <span class="team-score">${hasScore ? m.score.away : ""}</span>
          </div>
        </div>
        <div class="match-box-meta">
          <span class="status-badge ${isLive ? "live" : ""}">${isLive ? "LIVE" : isFinished ? "FT" : fmtTime(m.utcDate)}</span>
          ${thumbHtml}
        </div>
      </div>
    </div>`;
}

function renderScores(matchesData, highlightsData) {
  const el = document.getElementById("scores-list");
  const matches = matchesData?.matches ?? [];
  const videos = highlightsData?.videos ?? {};
  const results = matches.filter((m) => m.status === "FINISHED" || m.status === "IN_PLAY" || m.status === "PAUSED");

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
        <div class="match-grid">${dayMatches.map((m) => matchCard(m, videos[m.id])).join("")}</div>
      </section>`)
    .join("");
}

function renderHighlights(highlightsData, matchesData) {
  const el = document.getElementById("highlights-list");
  const videos = highlightsData?.videos ?? {};
  const matches = matchesData?.matches ?? [];
  const finished = matches.filter((m) => m.status === "FINISHED");

  if (!finished.length) {
    el.textContent = "No finished matches yet.";
    return;
  }

  const sorted = [...finished].sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate));
  const dayGroups = groupByDay(sorted);

  el.innerHTML = [...dayGroups.entries()]
    .map(([dayKey, dayMatches]) => `
      <section class="day-group">
        <div class="day-heading">${dayLabel(dayMatches[0].utcDate)}</div>
        <div class="highlight-grid">
          ${dayMatches
            .map((m) => {
              const video = videos[m.id];
              const fallbackQuery = encodeURIComponent(`${m.home} vs ${m.away} highlights FIFA World Cup 2026`);

              const thumbHtml = video
                ? `<button class="highlight-thumb" data-video-id="${video.videoId}" title="Play highlights">
                    <img src="https://img.youtube.com/vi/${video.videoId}/hqdefault.jpg" alt="" loading="lazy" />
                    <span class="play-badge">▶</span>
                  </button>`
                : `<a class="highlight-thumb" href="https://www.youtube.com/results?search_query=${fallbackQuery}" target="_blank" rel="noopener">
                    <div class="thumb-placeholder">🔍</div>
                  </a>`;

              return `
                <div class="highlight-card">
                  ${thumbHtml}
                  <div class="highlight-info">
                    <div class="highlight-teams">${teamName(m.home)} ${m.score.home}-${m.score.away} ${teamName(m.away)}</div>
                    <div class="highlight-title">${video?.title ?? "Search highlights on YouTube"}</div>
                  </div>
                </div>`;
            })
            .join("")}
        </div>
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
  const [matchesData, highlightsData, scorersData, standingsData] = await Promise.all([
    loadJson("matches.json"),
    loadJson("highlights.json"),
    loadJson("scorers.json"),
    loadJson("standings.json"),
  ]);

  renderScores(matchesData, highlightsData);
  renderHighlights(highlightsData, matchesData);
  renderStats(scorersData);
  renderTables(standingsData);

  const updatedAt = matchesData?.updatedAt;
  document.getElementById("last-updated").textContent = updatedAt
    ? `Last updated: ${fmtDate(updatedAt)}`
    : "";
}

init();
