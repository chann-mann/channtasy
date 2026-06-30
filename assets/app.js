/* Channtasy Cup leaderboard.
 * Loads bracket / scoring / results / picks JSON, derives which teams have actually
 * reached each round from the match results + bracket topology, scores every
 * participant (advancement-based, independent per round), and renders a ranked board.
 */

const MEDALS = ["🥇", "🥈", "🥉"];

async function loadJSON(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${path} (${res.status})`);
  return res.json();
}

/* Map each scored round to the round whose match winners "reach" it.
 * Winning your R32 match => you reached R16, etc. */
const REACH_FROM = { r16: "r32", qf: "r16", sf: "qf", final: "sf" };

/* From results.matchResults (matchId -> winner) + bracket topology, build the set
 * of teams that have actually reached each scored round, plus the actual champion. */
function deriveActuals(bracket, results) {
  const wins = results.matchResults || {};
  const reached = {};
  for (const [scoredRound, feederRound] of Object.entries(REACH_FROM)) {
    const matchIds = bracket.rounds[feederRound].map((m) => m.id);
    reached[scoredRound] = new Set(
      matchIds.map((id) => wins[id]).filter(Boolean)
    );
  }
  const finalId = bracket.rounds.final[0].id;
  const champion = wins[finalId] || null;
  return { reached, champion };
}

/* Teams that have actually been knocked out (lost a decided match). Used to mark
 * a participant's pick as wrong vs. merely undecided. */
function deriveEliminated(bracket, results) {
  const wins = results.matchResults || {};
  const elim = new Set();
  for (const m of bracket.rounds.r32) {
    if (wins[m.id]) m.teams.forEach((t) => { if (t !== wins[m.id]) elim.add(t); });
  }
  for (const round of ["r16", "qf", "sf", "final"]) {
    for (const m of bracket.rounds[round]) {
      const teams = m.feeds.map((f) => wins[f]).filter(Boolean);
      if (wins[m.id] && teams.length === 2) {
        teams.forEach((t) => { if (t !== wins[m.id]) elim.add(t); });
      }
    }
  }
  return elim;
}

/* hit = team correctly reached this round; miss = team eliminated (wrong);
 * pending = team still alive but the result for this round isn't in yet. */
function teamState(team, roundId, actuals, eliminated) {
  const reached = roundId === "champion"
    ? actuals.champion === team
    : actuals.reached[roundId].has(team);
  if (reached) return "hit";
  if (eliminated.has(team)) return "miss";
  return "pending";
}

function scoreParticipant(p, scoring, actuals) {
  const perRound = {};
  let total = 0;
  for (const round of scoring.rounds) {
    const predicted = p[round.id] || [];
    const actualSet = actuals.reached[round.id];
    const hits = predicted.filter((t) => actualSet.has(t)).length;
    const pts = hits * round.points;
    perRound[round.id] = { hits, pts };
    total += pts;
  }
  // champion
  const champHit = actuals.champion && p.champion === actuals.champion;
  const champPts = champHit ? scoring.champion.points : 0;
  perRound.champion = { hits: champHit ? 1 : 0, pts: champPts };
  total += champPts;
  return { total, perRound };
}

function rankRows(rows) {
  // sort by total desc; assign shared ("1224") ranks for ties
  rows.sort((a, b) => b.total - a.total || a.displayName.localeCompare(b.displayName));
  let lastTotal = null;
  let lastRank = 0;
  rows.forEach((r, i) => {
    if (r.total !== lastTotal) {
      lastRank = i + 1;
      lastTotal = r.total;
    }
    r.rank = lastRank;
  });
  return rows;
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function renderStatus(bracket, results, actuals) {
  const bar = document.getElementById("status-bar");
  const r32Total = bracket.rounds.r32.length;
  const r32Done = bracket.rounds.r32.filter((m) => (results.matchResults || {})[m.id]).length;
  const totalMatches =
    r32Total +
    bracket.rounds.r16.length +
    bracket.rounds.qf.length +
    bracket.rounds.sf.length +
    bracket.rounds.final.length;
  const done = Object.keys(results.matchResults || {}).length;
  const champ = actuals.champion ? bracket.teams[actuals.champion] : null;

  bar.innerHTML = "";
  bar.appendChild(el("span", "chip", `<strong>${done}</strong> / ${totalMatches} matches decided`));
  bar.appendChild(el("span", "chip", `Round of 32: <strong>${r32Done}</strong> / ${r32Total}`));
  if (champ) {
    bar.appendChild(el("span", "chip", `Champion: <strong>${champ.flag} ${champ.name}</strong>`));
  }
}

let lastFocus = null;

function ensureModal() {
  let m = document.getElementById("detail-modal");
  if (m) return m;
  m = el("div", "modal-backdrop");
  m.id = "detail-modal";
  m.hidden = true;
  m.innerHTML =
    '<div class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="modal-title">' +
    '<button class="modal-close" aria-label="Close">×</button>' +
    '<div class="modal-content"></div></div>';
  document.body.appendChild(m);
  const close = () => {
    m.hidden = true;
    document.body.classList.remove("modal-open");
    if (lastFocus) lastFocus.focus();
  };
  m.addEventListener("click", (e) => { if (e.target === m) close(); });
  m.querySelector(".modal-close").addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (!m.hidden && e.key === "Escape") close(); });
  return m;
}

/* Build the bracket detail view for one participant. */
function openDetail(r, bracket, scoring, actuals, eliminated) {
  lastFocus = document.activeElement;
  const m = ensureModal();
  const p = r.picks;
  const champTeam = bracket.teams[p.champion];

  const rankTxt = r.rank <= 3 ? MEDALS[r.rank - 1] : "#" + r.rank;
  const labels = {};
  scoring.rounds.forEach((rd) => (labels[rd.id] = rd.label.replace(/^Reached /, "")));

  const detailRounds = [
    { id: "champion", label: "Champion", teams: p.champion ? [p.champion] : [], pts: r.perRound.champion.pts },
    { id: "final", label: labels.final || "Final", teams: p.final || [], pts: r.perRound.final.pts },
    { id: "sf", label: labels.sf || "Semi-Finals", teams: p.sf || [], pts: r.perRound.sf.pts },
    { id: "qf", label: labels.qf || "Quarter-Finals", teams: p.qf || [], pts: r.perRound.qf.pts },
    { id: "r16", label: labels.r16 || "Round of 16", teams: p.r16 || [], pts: r.perRound.r16.pts },
  ];

  let html =
    '<div class="modal-head"><div class="modal-rank">' + rankTxt + "</div><div>" +
    '<h3 id="modal-title">' + p.displayName + "</h3>" +
    '<div class="modal-sub"><strong>' + r.total + " pts</strong> · Champion pick: " +
    (champTeam ? champTeam.flag + " " + champTeam.name : "—") + "</div></div></div>" +
    '<div class="legend"><span class="lg hit">Correct</span><span class="lg miss">Knocked out</span><span class="lg pend">Undecided</span></div>';

  for (const rd of detailRounds) {
    html += '<section class="dr"><div class="dr-head"><span>' + rd.label +
      '</span><span class="dr-pts">' + rd.pts + " pts</span></div><div class=\"chips\">";
    if (!rd.teams.length) {
      html += '<span class="chip2 pend">—</span>';
    } else {
      for (const t of rd.teams) {
        const team = bracket.teams[t] || { flag: "🏳️", name: t };
        const st = teamState(t, rd.id, actuals, eliminated);
        html += '<span class="chip2 ' + st + '" title="' + team.name + '">' + team.flag + " " + t + "</span>";
      }
    }
    html += "</div></section>";
  }

  m.querySelector(".modal-content").innerHTML = html;
  m.hidden = false;
  document.body.classList.add("modal-open");
  m.querySelector(".modal-close").focus();
}

function renderRows(rows, bracket, scoring, onSelect) {
  const body = document.getElementById("leaderboard-body");
  body.innerHTML = "";
  rows.forEach((r) => {
    const row = el("div", "row");
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `${r.displayName}, ${r.total} points — view bracket`);
    row.addEventListener("click", () => onSelect(r));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(r); }
    });
    if (r.rank <= 3) row.classList.add(`top${r.rank}`);

    const rankTxt = r.rank <= 3 ? MEDALS[r.rank - 1] : r.rank;
    row.appendChild(el("div", "rank", `${rankTxt}`));

    const champTeam = bracket.teams[r.champion];
    const who = el("div", "who");
    who.appendChild(el("div", "champ-flag", champTeam ? champTeam.flag : "🎲"));
    const nameBlock = el("div", "name-block");
    nameBlock.appendChild(el("div", "name", r.displayName));
    nameBlock.appendChild(
      el("div", "champ-label", `Champion pick: ${champTeam ? champTeam.name : "—"}`)
    );
    who.appendChild(nameBlock);
    row.appendChild(who);

    const breakdown = el("div", "breakdown");
    for (const round of scoring.rounds) {
      const cell = r.perRound[round.id];
      const b = el("span", "badge" + (cell.pts > 0 ? " scored" : ""),
        `<span class="lbl">${round.short}</span>${cell.pts}`);
      breakdown.appendChild(b);
    }
    const champCell = r.perRound.champion;
    breakdown.appendChild(
      el("span", "badge" + (champCell.pts > 0 ? " scored" : ""),
        `<span class="lbl">🏆</span>${champCell.pts}`)
    );
    row.appendChild(breakdown);

    row.appendChild(el("div", "total", `${r.total}`));
    body.appendChild(row);
  });
}

function renderPending(pending) {
  const section = document.getElementById("awaiting");
  const body = document.getElementById("awaiting-body");
  if (!pending.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  body.innerHTML = "";
  pending.forEach((p) => {
    body.appendChild(el("span", "pending-chip", p.displayName));
  });
}

async function main() {
  try {
    const [bracket, scoring, results, picks] = await Promise.all([
      loadJSON("data/bracket.json"),
      loadJSON("data/scoring.json"),
      loadJSON("data/results.json"),
      loadJSON("data/picks.json"),
    ]);

    const actuals = deriveActuals(bracket, results);
    const eliminated = deriveEliminated(bracket, results);

    const withBracket = picks.participants.filter((p) => p.hasBracket);
    const pending = picks.participants.filter((p) => !p.hasBracket);

    const rows = withBracket.map((p) => {
      const { total, perRound } = scoreParticipant(p, scoring, actuals);
      return { displayName: p.displayName, champion: p.champion, total, perRound, picks: p };
    });
    rankRows(rows);

    // prize pool: $perPerson for every person in the group, incl. those without brackets
    const perPerson = picks.prizePerPerson || 0;
    const players = picks.participants.length;
    if (perPerson > 0) {
      const banner = document.getElementById("prize-banner");
      banner.hidden = false;
      const pot = (perPerson * players).toLocaleString("en-US");
      banner.innerHTML =
        `<span class="prize-amount">$${pot}</span>` +
        `<span class="prize-sub">prize pool · $${perPerson} × ${players} players</span>`;
    }

    renderStatus(bracket, results, actuals);
    renderRows(rows, bracket, scoring, (r) => openDetail(r, bracket, scoring, actuals, eliminated));
    renderPending(pending);

    const note = document.getElementById("updated-note");
    if (results.lastUpdated) note.textContent = `Updated ${results.lastUpdated}`;
  } catch (err) {
    const e = document.getElementById("error");
    e.hidden = false;
    e.textContent = `${err.message}. If you opened this file directly, serve it instead: run "python3 -m http.server" in this folder and visit http://localhost:8000/`;
    console.error(err);
  }
}

main();
