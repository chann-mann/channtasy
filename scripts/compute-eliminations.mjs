#!/usr/bin/env node
/* Channtasy Cup — elimination analysis.
 *
 * Replays the knockout tournament game-by-game and works out, for every
 * participant, the exact match after which they became MATHEMATICALLY
 * eliminated (can no longer finish 1st), plus a short human explanation.
 *
 * Two tests are combined:
 *   - Domination ("similar bracket"): cheap, runs after every match. X is done
 *     the moment some Y sits ahead AND holds a superset of X's still-scoreable
 *     picks (same champion). Pinpoints most eliminations to a precise game.
 *   - Full enumeration: exact but only feasible once few matches remain; catches
 *     the "collectively boxed out" cases no single rival dominates.
 *
 * Writes data/eliminations.json. Run after scripts/fetch-results.mjs. Scorelines
 * are pulled from FIFA's API for flavour; if that fetch fails the labels simply
 * omit the score.
 *
 * Usage: node scripts/compute-eliminations.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");
const COMPETITION = process.env.FIFA_COMPETITION || "17";
const SEASON = process.env.FIFA_SEASON || "285023";
const API = `https://api.fifa.com/api/v3/calendar/matches?idCompetition=${COMPETITION}&idSeason=${SEASON}&count=200&language=en`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const bracket = JSON.parse(readFileSync(join(DATA, "bracket.json")));
const scoringDef = JSON.parse(readFileSync(join(DATA, "scoring.json")));
const results = JSON.parse(readFileSync(join(DATA, "results.json")));
const picks = JSON.parse(readFileSync(join(DATA, "picks.json"))).participants.filter((p) => p.hasBracket);

const NAME = (c) => (bracket.teams[c] || { name: c }).name;
const allRes = results.matchResults, kick = results.kickoffs || {};
const pmap = Object.fromEntries(picks.map((p) => [p.displayName, p]));
const REACH_FROM = { r16: "r32", qf: "r16", sf: "qf", final: "sf" };
const ROUND_LABEL = { r32: "Round of 32", r16: "Round of 16", qf: "Quarterfinal", sf: "Semifinal", final: "Final" };

async function fetchScores() {
  try {
    const res = await fetch(API, { headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    const json = await res.json();
    const map = {};
    const pk = (a, b) => [a, b].sort().join("-");
    for (const e of json.Results || []) {
      const h = (e.Home || {}).Abbreviation, a = (e.Away || {}).Abbreviation;
      if (h && a) map[pk(h, a)] = e;
    }
    return map;
  } catch (e) { return null; }
}

// chronological match numbering (all rounds, by kickoff)
const allMatches = [];
for (const r of ["r32", "r16", "qf", "sf", "final"]) for (const m of bracket.rounds[r]) allMatches.push({ id: m.id, round: r });
allMatches.sort((a, b) => new Date(kick[a.id] || "2099") - new Date(kick[b.id] || "2099"));
const matchNum = {}, roundOf = {};
allMatches.forEach((x, i) => { matchNum[x.id] = i + 1; roundOf[x.id] = x.round; });
const TOTAL = allMatches.length;

function reachedOf(w) { const r = {}; for (const [sr, fr] of Object.entries(REACH_FROM)) r[sr] = new Set(bracket.rounds[fr].map((m) => m.id).map((id) => w[id]).filter(Boolean)); return { r, champ: w[bracket.rounds.final[0].id] || null }; }
function score(p, w) { const { r, champ } = reachedOf(w); let t = 0; for (const rr of scoringDef.rounds) t += (p[rr.id] || []).filter((x) => r[rr.id].has(x)).length * rr.points; if (champ && p.champion === champ) t += scoringDef.champion.points; return t; }
function aliveFn(w) { const e = new Set(); for (const m of bracket.rounds.r32) { if (w[m.id]) m.teams.forEach((t) => { if (t !== w[m.id]) e.add(t); }); } for (const round of ["r16", "qf", "sf", "final"]) for (const m of bracket.rounds[round]) { const ts = m.feeds.map((f) => w[f]).filter(Boolean); if (w[m.id] && ts.length === 2) ts.forEach((t) => { if (t !== w[m.id]) e.add(t); }); } return (t) => t && !e.has(t); }
const subset = (a, b) => { const B = new Set(b); return a.every((x) => B.has(x)); };
function scoreable(p, round, alive, reached) { return (p[round] || []).filter((t) => alive(t) && !reached[round].has(t)); }
function dominator(name, cur, alive, reached, champ) {
  const X = pmap[name];
  for (const Y of picks) {
    if (Y.displayName === name || cur[Y.displayName] <= cur[name]) continue;
    let ok = true;
    for (const r of ["r16", "qf", "sf", "final"]) if (!subset(scoreable(X, r, alive, reached), scoreable(Y, r, alive, reached))) { ok = false; break; }
    if (!ok) continue;
    if (alive(X.champion) && X.champion !== champ && Y.champion !== X.champion) continue;
    return { n: Y.displayName, pts: cur[Y.displayName] };
  }
  return null;
}
function cantWin(w) {
  const rem = []; for (const round of ["r32", "r16", "qf", "sf", "final"]) for (const m of bracket.rounds[round]) if (!w[m.id]) rem.push({ round, m });
  const st = {}; picks.forEach((p) => st[p.displayName] = 0); const cw = { ...w };
  (function rec(i) { if (i === rem.length) { const sc = picks.map((p) => ({ n: p.displayName, s: score(p, cw) })); const top = Math.max(...sc.map((x) => x.s)); for (const x of sc) if (x.s === top) st[x.n]++; return; } const { round, m } = rem[i]; const teams = round === "r32" ? m.teams : m.feeds.map((f) => cw[f]); for (const t of teams) { cw[m.id] = t; rec(i + 1); } delete cw[m.id]; })(0);
  return new Set(picks.filter((p) => st[p.displayName] === 0).map((p) => p.displayName));
}

let SCORES = null;
function scoreline(id) {
  const round = roundOf[id];
  const teams = round === "r32" ? bracket.rounds.r32.find((x) => x.id === id).teams : bracket.rounds[round].find((x) => x.id === id).feeds.map((f) => allRes[f]);
  const w = allRes[id], l = teams.find((t) => t !== w);
  let sc = "";
  if (SCORES) { const pk = (a, b) => [a, b].sort().join("-"); const ev = SCORES[pk(teams[0], teams[1])]; if (ev) { const hs = +ev.HomeTeamScore, as = +ev.AwayTeamScore; if (Number.isFinite(hs) && Number.isFinite(as)) { const wS = (ev.Home || {}).Abbreviation === w ? hs : as, lS = (ev.Home || {}).Abbreviation === w ? as : hs; sc = hs === as ? `${wS}-${lS}, on penalties` : `${wS}-${lS}`; } } }
  return `${NAME(w)} beat ${NAME(l)}${sc ? " " + sc : ""}`;
}

function reason(fe) {
  const w = fe.w, alive = aliveFn(w);
  const cur = {}; picks.forEach((p) => cur[p.displayName] = score(p, w));
  const X = pmap[fe.name], champ = NAME(X.champion), champDead = !alive(X.champion);
  const h = [...fe.name].reduce((a, c) => a + c.charCodeAt(0), 0), pickV = (arr) => arr[h % arr.length];
  let ceil = cur[fe.name]; for (const r of ["qf", "sf", "final"]) { const pts = scoringDef.rounds.find((x) => x.id === r).points; ceil += (X[r] || []).filter((t) => alive(t) && !reachedOf(w).r[r].has(t)).length * pts; } if (alive(X.champion) && X.champion !== reachedOf(w).champ) ceil += 100;
  let base;
  if (fe.dom) {
    const d = fe.dom, gap = d.pts - cur[fe.name];
    if (champDead) base = `Your champion (${champ}) is already home on the couch — and ${d.n} still has every team you've got left, leading ${d.pts}–${cur[fe.name]}. Lost your winner AND got copied by someone ahead of you. No path to first.`;
    else base = pickV([
      `${d.n} backed every team you've still got alive — same champion (${champ}) and all — and sits ${d.pts}–${cur[fe.name]} ahead. Whatever you score from here, they score at least as much. You're their shadow now.`,
      `You and ${d.n} are rooting for the exact same teams the rest of the way (${champ} to lift it included), except they're up ${d.pts}–${cur[fe.name]}. An identical bracket from ${gap} points back isn't a strategy, it's a tribute act.`,
      `Every surviving pick of yours is also ${d.n}'s, and they lead ${d.pts}–${cur[fe.name]} with the same champion (${champ}). You can tie them at best, never pass them. Congrats on the knockoff bracket.`,
    ]);
  } else {
    base = pickV([
      `No single rival did you in — the whole field just quietly stepped over you. Run the table on every team you've got left and you still cap at ${ceil}, and the leaders are already past that. Death by a thousand cuts.`,
      `Nobody even had to try; everybody beat you a little. Your absolute dream run tops out at ${ceil} — short of the pack no matter what happens. The math just closed the door.`,
      `It's not one villain, it's the whole field. Best case you scrape ${ceil}, which the leaders cleared a while ago. Every remaining outcome leaves somebody above you.`,
    ]);
  }
  // Special roast for the commissioner and his better half.
  const SNARK = {
    channmann: "🎖️ The commissioner himself — eliminated in his own pool. Turns out running the thing comes with exactly zero bonus points. ",
    soffffffff: "💔 The commissioner's girlfriend is out — cold shoulder at home incoming, and he'd better hope he outlasts her or he'll never hear the end of it. ",
  };
  return (SNARK[fe.name] || "") + base;
}

async function main() {
  SCORES = await fetchScores();
  const decided = allMatches.filter((x) => allRes[x.id]).map((x) => x.id); // chronological
  const firstElim = {};
  const w = {};
  for (const id of decided) {
    w[id] = allRes[id];
    const remCount = TOTAL - Object.keys(w).length;
    const alive = aliveFn(w); const { r: reached, champ } = reachedOf(w);
    const cur = {}; picks.forEach((p) => cur[p.displayName] = score(p, w));
    for (const p of picks) {
      if (firstElim[p.displayName]) continue;
      const dom = dominator(p.displayName, cur, alive, reached, champ);
      if (dom) firstElim[p.displayName] = { name: p.displayName, id, num: matchNum[id], dom, w: { ...w } };
    }
    if (remCount <= 16) {
      const cw = cantWin(w);
      for (const p of picks) if (!firstElim[p.displayName] && cw.has(p.displayName)) firstElim[p.displayName] = { name: p.displayName, id, num: matchNum[id], dom: null, w: { ...w } };
    }
  }

  const byName = {};
  for (const n of Object.keys(firstElim)) {
    const fe = firstElim[n];
    byName[n] = { after: fe.id, afterNum: fe.num, afterIndex: fe.num, afterLabel: `Match ${fe.num}/${TOTAL} · ${scoreline(fe.id)} (${ROUND_LABEL[roundOf[fe.id]]})`, reason: reason(fe) };
  }
  const latestId = decided[decided.length - 1] || null;
  const newly = latestId ? Object.keys(byName).filter((n) => byName[n].after === latestId) : [];
  const outObj = { totalMatches: TOTAL, latestMatch: latestId, latestNum: latestId ? matchNum[latestId] : null, latestLabel: latestId ? scoreline(latestId) : "", newlyEliminated: newly, byName };
  writeFileSync(join(DATA, "eliminations.json"), JSON.stringify(outObj, null, 2) + "\n");
  console.log(`Wrote data/eliminations.json — ${Object.keys(byName).length} eliminated of ${picks.length}; ${newly.length} new after match ${outObj.latestNum}/${TOTAL}.`);
}

main();
