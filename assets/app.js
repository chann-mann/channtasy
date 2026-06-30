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

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// Render a display name, turning any trailing asterisk(s) into a prominent
// "tainted record" mark (MLB steroid-era style).
function fmtName(name) {
  const m = String(name).match(/^(.*?)(\*+)$/);
  if (!m) return escHtml(name);
  return escHtml(m[1]) + '<sup class="taint" data-tip="Record under review — suspected performance enhancement" tabindex="0">' + m[2] + "</sup>";
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

/* Reconstruct the full per-match bracket tree from a participant's round picks
 * + the fixed topology. Each match = its two teams and the one they advanced. */
function buildTree(p, bracket) {
  const pickByMatch = {};
  const tree = {};
  tree.r32 = bracket.rounds.r32.map((m) => {
    const pick = m.teams.find((t) => (p.r16 || []).includes(t)) || null;
    pickByMatch[m.id] = pick;
    return { teams: [...m.teams], pick };
  });
  const winnerList = { r16: "qf", qf: "sf", sf: "final", final: null };
  for (const round of ["r16", "qf", "sf", "final"]) {
    tree[round] = bracket.rounds[round].map((m) => {
      const teams = m.feeds.map((f) => pickByMatch[f] || null);
      let pick = null;
      if (round === "final") pick = p.champion || null;
      else {
        const wl = p[winnerList[round]] || [];
        pick = teams.find((t) => t && wl.includes(t)) || null;
      }
      pickByMatch[m.id] = pick;
      return { teams, pick };
    });
  }
  return tree;
}

/* Round a pick belongs to once it WINS that match (used for correctness colour). */
const WIN_REACH = { r32: "r16", r16: "qf", qf: "sf", sf: "final", final: "champion" };
const ROUND_LABEL = { r32: "R32", r16: "R16", qf: "QF", sf: "SF", final: "Final" };

function teamCell(code, bracket, isPick, state) {
  const team = bracket.teams[code] || { flag: "🏳️", name: code || "TBD" };
  const cls = "bk-team" + (isPick ? " pick " + state : " drop");
  return '<div class="' + cls + '" title="' + team.name + '">' +
    '<span class="bk-fl">' + (code ? team.flag : "·") + "</span>" +
    '<span class="bk-code">' + (code || "—") + "</span></div>";
}

/* Build the bracket detail view for one participant. */
function openDetail(r, bracket, scoring, actuals, eliminated) {
  lastFocus = document.activeElement;
  const m = ensureModal();
  const p = r.picks;
  const champTeam = bracket.teams[p.champion];
  const rankTxt = r.rank <= 3 ? MEDALS[r.rank - 1] : "#" + r.rank;
  const tree = buildTree(p, bracket);

  // index match-ids within each round so we can recurse via the feeder topology
  const PREV = { r16: "r32", qf: "r16", sf: "qf", final: "sf" };
  const idIndex = {};
  for (const rd of ["r32", "r16", "qf", "sf", "final"]) {
    idIndex[rd] = {};
    bracket.rounds[rd].forEach((mm, i) => (idIndex[rd][mm.id] = i));
  }

  function matchBox(round, idx, extraCls) {
    const t = tree[round][idx];
    let inner = "";
    t.teams.forEach((code) => {
      const isPick = code && code === t.pick;
      const st = isPick ? teamState(code, WIN_REACH[round], actuals, eliminated) : "";
      inner += teamCell(code, bracket, isPick, st);
    });
    return '<div class="bk-box' + (extraCls ? " " + extraCls : "") + '">' + inner + "</div>";
  }

  function renderNode(round, idx) {
    if (round === "r32") return '<div class="node leaf">' + matchBox(round, idx) + "</div>";
    const prev = PREV[round];
    const kids = '<div class="node-kids">' +
      bracket.rounds[round][idx].feeds.map((fid) => renderNode(prev, idIndex[prev][fid])).join("") +
      "</div>";
    return '<div class="node">' + kids + matchBox(round, idx) + "</div>";
  }

  const champState = p.champion ? teamState(p.champion, "champion", actuals, eliminated) : "";
  const champBox = '<div class="bk-box bk-champ-box">' +
    teamCell(p.champion, bracket, !!p.champion, champState) + "</div>";

  const html =
    '<div class="modal-head"><div class="modal-rank">' + rankTxt + "</div><div>" +
    '<h3 id="modal-title">' + fmtName(p.displayName) + "</h3>" +
    '<div class="modal-sub"><strong>' + r.total + " pts</strong> · Champion pick: " +
    (champTeam ? champTeam.flag + " " + champTeam.name : "—") + "</div></div></div>" +
    (/\*+$/.test(p.displayName)
      ? '<div class="taint-banner">⚠ Record under review — suspected performance enhancement</div>'
      : "") +
    '<div class="legend"><span class="lg hit">Correct</span><span class="lg miss">Knocked out</span><span class="lg pend">Undecided</span></div>' +
    '<div class="bk-scroll">' +
      '<div class="bk-labels"><span>R32</span><span>R16</span><span>QF</span><span>SF</span><span>Final</span><span>🏆</span></div>' +
      '<div class="bk-rootrow">' + renderNode("final", 0) + champBox + "</div>" +
    "</div>";

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
    nameBlock.appendChild(el("div", "name", fmtName(r.displayName)));
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
