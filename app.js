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

function renderScores(matchesData) {
  const el = document.getElementById("scores-list");
  if (!matchesData?.matches?.length) {
    el.textContent = "No match data yet — check back once the data pipeline has run.";
    return;
  }
  const sorted = [...matchesData.matches].sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate));
  el.innerHTML = sorted
    .map((m) => {
      const isLive = m.status === "IN_PLAY" || m.status === "PAUSED";
      const scoreText =
        m.score.home === null && m.score.away === null ? fmtDate(m.utcDate) : `${m.score.home} - ${m.score.away}`;
      return `
        <div class="card">
          <div class="match-teams">
            ${m.homeCrest ? `<img class="crest" src="${m.homeCrest}" alt="" />` : ""}
            <span>${m.home}</span>
            <span class="score">${scoreText}</span>
            <span>${m.away}</span>
            ${m.awayCrest ? `<img class="crest" src="${m.awayCrest}" alt="" />` : ""}
          </div>
          <span class="status-badge ${isLive ? "live" : ""}">${m.status.replace("_", " ")}</span>
        </div>`;
    })
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

  el.innerHTML = finished
    .map((m) => {
      const video = videos[m.id];
      const fallbackQuery = encodeURIComponent(`${m.home} vs ${m.away} highlights FIFA World Cup 2026`);
      const link = video
        ? `<a class="yt-link" href="${video.url}" target="_blank" rel="noopener">▶ Watch highlights</a>`
        : `<a class="yt-link" href="https://www.youtube.com/results?search_query=${fallbackQuery}" target="_blank" rel="noopener">🔍 Search on YouTube</a>`;
      return `
        <div class="card">
          <div class="match-teams"><span>${m.home}</span><span class="score">${m.score.home} - ${m.score.away}</span><span>${m.away}</span></div>
          ${link}
        </div>`;
    })
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

  renderScores(matchesData);
  renderHighlights(highlightsData, matchesData);
  renderStats(scorersData);
  renderTables(standingsData);

  const updatedAt = matchesData?.updatedAt;
  document.getElementById("last-updated").textContent = updatedAt
    ? `Last updated: ${fmtDate(updatedAt)}`
    : "";
}

init();
