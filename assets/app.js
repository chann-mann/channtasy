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

// Tiebreak sort key: normal alphabetic, but names led by a symbol (e.g. the
// "(*)" tainted marker) sort AFTER all a-z/A-Z names. Letters, digits and
// spaces keep their order; any other char is pushed to the end of the alphabet.
function nameSortKey(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9 ]/g, "￿");
}

function rankRows(rows) {
  // sort by total desc; tiebreak alphabetically (symbols last); assign shared ranks
  rows.sort(
    (a, b) =>
      b.total - a.total ||
      nameSortKey(a.displayName).localeCompare(nameSortKey(b.displayName)) ||
      a.displayName.localeCompare(b.displayName)
  );
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

const TAINT_TIP = "Record under review — suspected performance enhancement";

// A name is "tainted" (MLB steroid-era style) if it carries an asterisk marker:
// a leading "(*)" prefix (preferred) or a trailing "*" (legacy). Returns the
// clean base name with the marker stripped.
function taintInfo(name) {
  const s = String(name);
  let m;
  if ((m = s.match(/^\(\*\)\s*(.*)$/))) return { tainted: true, base: m[1] };
  if ((m = s.match(/^(.*?)\*+$/))) return { tainted: true, base: m[1] };
  return { tainted: false, base: s };
}

// Render a display name. Tainted names show a prominent "(*)" mark and the whole
// name becomes the hover/focus target for the "record under review" tooltip.
function fmtName(name) {
  const { tainted, base } = taintInfo(name);
  if (!tainted) return escHtml(name);
  return (
    '<span class="taint-name" tabindex="0" data-tip="' + escHtml(TAINT_TIP) + '">' +
    "(*) " + escHtml(base) +
    "</span>"
  );
}

// One shared, fixed-positioned tooltip element + event delegation. Fixed
// positioning means no overflow:hidden ancestor can clip it, which is what made
// the previous pure-CSS tooltip flaky.
function initTooltip() {
  if (document.querySelector(".app-tooltip")) return;
  const tip = el("div", "app-tooltip");
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  document.body.appendChild(tip);
  let cur = null;

  function place() {
    if (!cur) return;
    const r = cur.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    let top = r.top - t.height - 8;
    if (top < 4) top = r.bottom + 8; // flip below if no room above
    let left = r.left + r.width / 2 - t.width / 2;
    left = Math.max(6, Math.min(left, window.innerWidth - t.width - 6));
    tip.style.top = top + "px";
    tip.style.left = left + "px";
  }
  function show(target) {
    cur = target;
    tip.textContent = target.getAttribute("data-tip") || "";
    tip.hidden = false;
    place(); // forces reflow so the opacity transition animates from this point
    tip.classList.add("show");
  }
  function hide() {
    cur = null;
    tip.classList.remove("show");
    tip.hidden = true;
  }

  document.addEventListener("mouseover", (e) => {
    const t = e.target.closest("[data-tip]");
    if (t && t !== cur) show(t);
  });
  document.addEventListener("mouseout", (e) => {
    const t = e.target.closest("[data-tip]");
    if (t && t === cur && !t.contains(e.relatedTarget)) hide();
  });
  document.addEventListener("focusin", (e) => {
    const t = e.target.closest("[data-tip]");
    if (t) show(t);
  });
  document.addEventListener("focusout", (e) => {
    const t = e.target.closest("[data-tip]");
    if (t && t === cur) hide();
  });
  window.addEventListener("scroll", place, true);
  window.addEventListener("resize", place);
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

/* ---- Next match: who backed each side ---- */
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const ROUND_ORDER = { r32: 0, r16: 1, qf: 2, sf: 3, final: 4 };

// Parse bracket date strings like "2 Jul, 16:00" or "4 Jul" (year assumed 2026).
function parseMatchDate(s) {
  const m = String(s || "").match(/(\d{1,2})\s+([A-Za-z]{3})(?:,\s*(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const mon = MONTHS[m[2].toLowerCase()];
  if (mon == null) return null;
  return new Date(2026, mon, +m[1], m[3] ? +m[3] : 12, m[4] ? +m[4] : 0);
}

// The next playable match: earliest undecided fixture whose both teams are known.
function findNextMatch(bracket, results) {
  const wins = results.matchResults || {};
  const cands = [];
  for (const round of ["r32", "r16", "qf", "sf", "final"]) {
    bracket.rounds[round].forEach((m, idx) => {
      if (wins[m.id]) return; // already decided
      const teams = round === "r32" ? [...m.teams] : m.feeds.map((f) => wins[f]);
      if (teams.length === 2 && teams[0] && teams[1]) {
        cands.push({ id: m.id, round, idx, teams, date: m.date, dt: parseMatchDate(m.date) });
      }
    });
  }
  if (!cands.length) return null;
  cands.sort((a, b) =>
    (a.dt && b.dt ? a.dt - b.dt : 0) ||
    ROUND_ORDER[a.round] - ROUND_ORDER[b.round] ||
    a.idx - b.idx
  );
  return cands[0];
}

// Bucket participants by which of the match's two teams they picked to win it.
function nextMatchPicks(nm, withBracket) {
  const [A, B] = nm.teams;
  const key = WIN_REACH[nm.round]; // r16/qf/sf/final -> pick array; final -> "champion"
  const forA = [], forB = [], other = [];
  for (const p of withBracket) {
    let choseA, choseB;
    if (nm.round === "final") { choseA = p.champion === A; choseB = p.champion === B; }
    else { const arr = p[key] || []; choseA = arr.includes(A); choseB = arr.includes(B); }
    if (choseA) forA.push(p.displayName);
    else if (choseB) forB.push(p.displayName);
    else other.push(p.displayName);
  }
  const byName = (x, y) => nameSortKey(x).localeCompare(nameSortKey(y)) || x.localeCompare(y);
  return { forA: forA.sort(byName), forB: forB.sort(byName), other: other.sort(byName) };
}

function renderNextMatch(bracket, results, withBracket) {
  const section = document.getElementById("next-match");
  if (!section) return;
  const nm = findNextMatch(bracket, results);
  if (!nm) { section.hidden = true; return; }

  const [A, B] = nm.teams;
  const ta = bracket.teams[A] || { flag: "🏳️", name: A };
  const tb = bracket.teams[B] || { flag: "🏳️", name: B };
  const { forA, forB, other } = nextMatchPicks(nm, withBracket);
  const dateLbl = nm.date ? " · " + escHtml(nm.date) : "";

  const side = (team, names) =>
    '<div class="nm-side">' +
      '<div class="nm-team">' +
        '<span class="nm-flag">' + team.flag + "</span>" +
        '<span class="nm-name">' + escHtml(team.name) + "</span>" +
        '<span class="nm-count">' + names.length + "</span>" +
      "</div>" +
      (names.length
        ? '<div class="nm-list nm-clamp">' + names.map((n) => fmtName(n)).join(", ") + "</div>" +
          '<button class="nm-toggle" type="button" hidden>Show all</button>'
        : '<p class="nm-empty">No backers</p>') +
    "</div>";

  section.innerHTML =
    '<div class="nm-eyebrow">Next up · ' + (ROUND_LABEL[nm.round] || nm.round) + dateLbl + "</div>" +
    '<div class="nm-grid">' + side(ta, forA) + '<div class="nm-vs">vs</div>' + side(tb, forB) + "</div>" +
    (other.length ? '<div class="nm-other">' + other.length + " had a different path to here</div>" : "");
  section.hidden = false;

  // Show a toggle only where the clamped (2-line) list actually overflows.
  section.querySelectorAll(".nm-side").forEach((sideEl) => {
    const list = sideEl.querySelector(".nm-list");
    const btn = sideEl.querySelector(".nm-toggle");
    if (!list || !btn) return;
    if (list.scrollHeight - list.clientHeight > 2) {
      btn.hidden = false;
      btn.addEventListener("click", () => {
        const clamped = list.classList.toggle("nm-clamp");
        btn.textContent = clamped ? "Show all" : "Show less";
      });
    }
  });
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
    (taintInfo(p.displayName).tainted
      ? '<div class="taint-banner">⚠ ' + TAINT_TIP + "</div>"
      : "") +
    (p.banner ? '<div class="hack-banner">' + escHtml(p.banner) + "</div>" : "") +
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
    who.appendChild(el("div", "champ-flag", champTeam ? champTeam.flag : "—"));
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

/* Ad creatives. Add a new one by dropping the image in assets/ and appending
   an entry here — rotation and everything else picks it up automatically. */
const ADS = [
  { src: "assets/phillbull-ad.jpg", alt: "PhillBull — Official Energy Drink of Last Minute Edits" },
  { src: "assets/phoong-law-ad.jpg", alt: "Bracket wrong? Call Ann Phoong — Phoong Law, 800-005-0005" },
  { src: "assets/ozo-theory-ad.jpg", alt: "A Beautiful Mind's Game: Ozo's Theory of Everything You Already Knew" },
];

/* Ad overlay. Opens on the given creative (index) and lets you page through the
   whole collection with the ‹ › arrows, wrapping around at both ends.
   Dismiss via the × button, clicking the backdrop, or Escape. */
function showAd(startIndex) {
  if (document.querySelector(".ad-overlay")) return; // already open
  if (!ADS.length) return;
  let i = ((startIndex || 0) % ADS.length + ADS.length) % ADS.length;

  const ov = el("div", "ad-overlay");
  const multi = ADS.length > 1;
  ov.innerHTML =
    '<div class="ad-card" role="dialog" aria-label="Advertisement">' +
      '<span class="ad-flag">Ad</span>' +
      '<button class="ad-close" aria-label="Close ad">&times;</button>' +
      '<img class="ad-img" src="" alt="">' +
      (multi
        ? '<button class="ad-nav ad-prev" aria-label="Previous ad">&#8249;</button>' +
          '<button class="ad-nav ad-next" aria-label="Next ad">&#8250;</button>'
        : "") +
    "</div>";

  const img = ov.querySelector(".ad-img");
  function render() {
    const ad = ADS[i];
    img.src = ad.src;
    img.alt = ad.alt || "";
  }
  function go(delta) {
    i = (i + delta % ADS.length + ADS.length) % ADS.length;
    render();
  }
  render();

  function close() {
    ov.remove();
    document.removeEventListener("keydown", onKey);
    document.body.classList.remove("modal-open");
  }
  function onKey(e) {
    if (e.key === "Escape") close();
    else if (multi && e.key === "ArrowLeft") go(-1);
    else if (multi && e.key === "ArrowRight") go(1);
  }

  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  ov.querySelector(".ad-close").addEventListener("click", close);
  if (multi) {
    ov.querySelector(".ad-prev").addEventListener("click", () => go(-1));
    ov.querySelector(".ad-next").addEventListener("click", () => go(1));
  }
  document.addEventListener("keydown", onKey);

  document.body.appendChild(ov);
  document.body.classList.add("modal-open");
}

/* Always show an ad on load, starting on a random creative. ?ad=N forces a
   specific creative (1-based) for previewing. */
function initAd() {
  const m = location.search.match(/[?&]ad=(\d+)/);
  if (m) { showAd(parseInt(m[1], 10) - 1); return; }
  showAd(Math.floor(Math.random() * ADS.length));
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
    const players = picks.participants.filter((p) => !p.fake).length;
    if (perPerson > 0) {
      const banner = document.getElementById("prize-banner");
      banner.hidden = false;
      const pot = (perPerson * players).toLocaleString("en-US");
      banner.innerHTML =
        `<span class="prize-amount">$${pot}</span>` +
        `<span class="prize-sub">prize pool · $${perPerson} × ${players} players</span>`;
    }

    initTooltip();
    initAd();
    renderStatus(bracket, results, actuals);
    renderNextMatch(bracket, results, withBracket);
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
