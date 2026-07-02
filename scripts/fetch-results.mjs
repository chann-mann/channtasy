#!/usr/bin/env node
/* Channtasy Cup — results fetcher (FIFA official data API).
 *
 * Pulls finished FIFA World Cup 2026 knockout matches straight from FIFA's own
 * JSON API (the same data that powers fifa.com) and writes the winners into
 * data/results.json, keyed by our match ids. Because it reads the structured
 * feed rather than scraping HTML, it gets the authoritative winner directly —
 * including penalty-shootout results that score-only sources miss.
 *
 * Behaviour (deliberately conservative):
 *   - DRY-RUN by default: prints what it would change, writes nothing.
 *     Pass --write to actually update results.json.
 *   - Never overwrites a result you already recorded, unless you pass --force.
 *   - Only fills a match when BOTH its teams are known and FIFA reports it
 *     FINISHED with a decided winner. Later rounds resolve iteratively as
 *     earlier winners become known.
 *
 * Match ids: M1-M16 = R32, A1-D2 = R16, QA-QD = QF, S1/S2 = SF, F = Final.
 *
 * Usage:
 *   node scripts/fetch-results.mjs            # dry run, show proposed changes
 *   node scripts/fetch-results.mjs --write    # apply changes to results.json
 *   node scripts/fetch-results.mjs --write --force  # also re-decide existing ones
 *
 * Config (env, optional): FIFA_COMPETITION (default 17), FIFA_SEASON (default
 * 285023 = World Cup 2026). Update FIFA_SEASON for a future tournament.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");

const COMPETITION = process.env.FIFA_COMPETITION || "17"; // FIFA World Cup
const SEASON = process.env.FIFA_SEASON || "285023"; // World Cup 2026 (Can/Mex/USA)
const API =
  `https://api.fifa.com/api/v3/calendar/matches` +
  `?idCompetition=${COMPETITION}&idSeason=${SEASON}&count=200&language=en`;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const WRITE = process.argv.includes("--write");
const FORCE = process.argv.includes("--force");

const MATCH_STATUS_FINISHED = 0; // FIFA: 0 = finished, 1 = not started, 3 = live

// FIFA abbreviations already match our 3-letter codes; keep a hook for any that
// ever diverge (source abbr -> our code).
const CODE_ALIAS = {};
const codeOf = (abbr) => CODE_ALIAS[abbr] || abbr || null;
const pairKey = (a, b) => [a, b].sort().join("-");

function winnerCode(m) {
  const home = m.Home || {};
  const away = m.Away || {};
  const hc = codeOf(home.Abbreviation);
  const ac = codeOf(away.Abbreviation);
  if (!hc || !ac) return null;
  // Prefer FIFA's explicit Winner (a team id) — this correctly reflects
  // extra-time / penalty outcomes.
  if (m.Winner != null) {
    if (String(m.Winner) === String(home.IdTeam)) return hc;
    if (String(m.Winner) === String(away.IdTeam)) return ac;
  }
  // Fallback: regulation score, then penalties.
  const hs = Number(m.HomeTeamScore);
  const as = Number(m.AwayTeamScore);
  if (Number.isFinite(hs) && Number.isFinite(as)) {
    if (hs > as) return hc;
    if (as > hs) return ac;
    const hp = Number(m.HomeTeamPenaltyScore);
    const ap = Number(m.AwayTeamPenaltyScore);
    if (Number.isFinite(hp) && Number.isFinite(ap)) {
      if (hp > ap) return hc;
      if (ap > hp) return ac;
    }
  }
  return null; // undecided / not enough info — leave for manual entry
}

async function fetchFinishedByPair() {
  const res = await fetch(API, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const json = await res.json();
  const events = json.Results || [];
  const byPair = new Map();
  for (const m of events) {
    if (m.MatchStatus !== MATCH_STATUS_FINISHED) continue;
    const home = codeOf((m.Home || {}).Abbreviation);
    const away = codeOf((m.Away || {}).Abbreviation);
    if (!home || !away) continue; // placeholder fixtures (TBD teams)
    const winner = winnerCode(m);
    if (!winner) continue;
    byPair.set(pairKey(home, away), { home, away, winner });
  }
  return byPair;
}

// For each match id, the two team codes that ACTUALLY contest it, using known
// results to resolve later rounds. Returns { matchId: [teamA, teamB] }.
function actualPairings(bracket, results) {
  const wins = { ...results.matchResults };
  const pairs = {};
  for (const m of bracket.rounds.r32) pairs[m.id] = [...m.teams];
  for (const round of ["r16", "qf", "sf", "final"]) {
    for (const m of bracket.rounds[round]) {
      const [f1, f2] = m.feeds.map((f) => wins[f]);
      if (f1 && f2) pairs[m.id] = [f1, f2];
    }
  }
  return pairs;
}

async function main() {
  const bracket = JSON.parse(readFileSync(join(DATA, "bracket.json")));
  const results = JSON.parse(readFileSync(join(DATA, "results.json")));
  results.matchResults = results.matchResults || {};

  let byPair;
  try {
    byPair = await fetchFinishedByPair();
  } catch (err) {
    console.error(`Could not reach the FIFA results API (${err.message}).`);
    console.error("Hand-edit data/results.json instead — see the comment at the top of that file.");
    process.exit(1);
  }

  // Resolve iteratively: a newly-decided match can unlock the next round's pairing.
  const proposed = {};
  for (let pass = 0; pass < 6; pass++) {
    const merged = { ...results.matchResults, ...proposed };
    const pairings = actualPairings(bracket, { matchResults: merged });
    let changed = false;
    for (const [matchId, teams] of Object.entries(pairings)) {
      if (teams.length !== 2) continue;
      if (merged[matchId] && !FORCE) continue;
      const src = byPair.get(pairKey(teams[0], teams[1]));
      if (src && src.winner && proposed[matchId] !== src.winner) {
        proposed[matchId] = src.winner;
        changed = true;
      }
    }
    if (!changed) break;
  }

  const changes = Object.entries(proposed).filter(
    ([id, w]) => results.matchResults[id] !== w
  );

  if (!changes.length) {
    console.log("No new finished knockout results found to apply.");
    console.log(`(FIFA API returned ${byPair.size} finished, mapped fixtures.)`);
    return;
  }

  console.log(WRITE ? "Applying:" : "Would apply (dry run — pass --write to save):");
  for (const [id, w] of changes) {
    const was = results.matchResults[id];
    console.log(`  ${id}: ${was ? was + " -> " : ""}${w}`);
  }

  if (WRITE) {
    Object.assign(results.matchResults, proposed);
    results.lastUpdated = new Date().toISOString().slice(0, 10);
    writeFileSync(join(DATA, "results.json"), JSON.stringify(results, null, 2) + "\n");
    console.log(`\nWrote ${changes.length} result(s) to data/results.json.`);
  }
}

main();
