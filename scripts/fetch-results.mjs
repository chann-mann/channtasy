#!/usr/bin/env node
/* Channtasy Cup — results fetcher.
 *
 * Pulls finished FIFA World Cup 2026 knockout matches from TheSportsDB (free API)
 * and proposes winners for each fixture in data/bracket.json, writing them into
 * data/results.json (keyed by match id). It is deliberately conservative:
 *   - DRY-RUN by default: prints what it would change, writes nothing.
 *     Pass --write to actually update results.json.
 *   - Never overwrites a result you already recorded, unless you pass --force.
 *   - Only fills a match when BOTH its teams are known and a finished source
 *     event for that exact pairing is found. Later rounds resolve iteratively
 *     as earlier winners become known.
 *
 * The data source for an unplayed/just-started tournament is often incomplete,
 * so the authoritative workflow is simply hand-editing data/results.json:
 *     "matchResults": { "M3": "CAN", "M1": "GER", ... }
 * Match ids: M1-M16 = R32, A1-D2 = R16, QA-QD = QF, S1/S2 = SF, F = Final.
 *
 * Usage:
 *   node scripts/fetch-results.mjs            # dry run, show proposed changes
 *   node scripts/fetch-results.mjs --write    # apply changes to results.json
 *   node scripts/fetch-results.mjs --write --force  # also re-decide existing ones
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");
const LEAGUE_ID = "4429"; // FIFA World Cup on TheSportsDB
const SEASON = "2026";
const API = `https://www.thesportsdb.com/api/v1/json/3/eventsseason.php?id=${LEAGUE_ID}&s=${SEASON}`;

const WRITE = process.argv.includes("--write");
const FORCE = process.argv.includes("--force");

// Source team name (lowercased) -> our 3-letter code. Includes common variants.
const NAME_TO_CODE = {
  germany: "GER", paraguay: "PAR", france: "FRA", sweden: "SWE",
  "south africa": "RSA", canada: "CAN", netherlands: "NED", holland: "NED",
  morocco: "MAR", portugal: "POR", croatia: "CRO", spain: "ESP", austria: "AUT",
  usa: "USA", "united states": "USA", "bosnia-herzegovina": "BIH",
  "bosnia and herzegovina": "BIH", belgium: "BEL", senegal: "SEN", brazil: "BRA",
  japan: "JPN", norway: "NOR", "ivory coast": "CIV", "cote d'ivoire": "CIV",
  "côte d'ivoire": "CIV", mexico: "MEX", ecuador: "ECU", england: "ENG",
  "dr congo": "COD", "congo dr": "COD", "democratic republic of congo": "COD",
  argentina: "ARG", "cape verde": "CPV", "cabo verde": "CPV", australia: "AUS",
  egypt: "EGY", switzerland: "SUI", algeria: "ALG", colombia: "COL", ghana: "GHA",
};

const codeOf = (name) => NAME_TO_CODE[(name || "").trim().toLowerCase()] || null;
const pairKey = (a, b) => [a, b].sort().join("-");

async function fetchFinishedEvents() {
  const res = await fetch(API);
  if (!res.ok) throw new Error(`API ${res.status}`);
  const json = await res.json();
  const events = json.events || [];
  const finished = [];
  for (const e of events) {
    if ((e.strStatus || "").toUpperCase() !== "FT" && e.strStatus !== "Match Finished") continue;
    const home = codeOf(e.strHomeTeam);
    const away = codeOf(e.strAwayTeam);
    if (!home || !away) continue;
    const hs = parseInt(e.intHomeScore, 10);
    const as = parseInt(e.intAwayScore, 10);
    let winner = null;
    if (Number.isFinite(hs) && Number.isFinite(as)) {
      if (hs > as) winner = home;
      else if (as > hs) winner = away;
      // tie => decided on penalties; TheSportsDB rarely exposes the shootout,
      // so leave unresolved for manual entry rather than guess.
    }
    finished.push({ pair: pairKey(home, away), home, away, winner, label: `${e.strHomeTeam} ${hs}-${as} ${e.strAwayTeam}` });
  }
  return new Map(finished.map((f) => [f.pair, f]));
}

// Build, for each match id, the two team codes that ACTUALLY contest it, using
// known results to resolve later rounds. Returns { matchId: [teamA, teamB] }.
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

  let bySource;
  try {
    bySource = await fetchFinishedEvents();
  } catch (err) {
    console.error(`Could not reach the results API (${err.message}).`);
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
      const src = bySource.get(pairKey(teams[0], teams[1]));
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
    console.log(`(Source returned ${bySource.size} finished, code-mapped fixtures.)`);
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
