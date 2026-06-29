/* Shared renderer for the Channtasy Cup theme previews.
 * Identical scoring logic to the live app; renders into theme-agnostic hooks
 * (#cc-prize, #cc-meta, #cc-board, #cc-waiting) that each theme styles via .cc-* classes.
 * Lives in /previews/, so it reads data from ../data/.
 */
(function () {
  const MEDALS = ["🥇", "🥈", "🥉"];
  const REACH_FROM = { r16: "r32", qf: "r16", sf: "qf", final: "sf" };

  async function loadJSON(p) {
    const r = await fetch(p, { cache: "no-store" });
    if (!r.ok) throw new Error(`Failed to load ${p}`);
    return r.json();
  }

  function deriveActuals(bracket, results) {
    const wins = results.matchResults || {};
    const reached = {};
    for (const [scored, feeder] of Object.entries(REACH_FROM)) {
      reached[scored] = new Set(bracket.rounds[feeder].map((m) => wins[m.id]).filter(Boolean));
    }
    return { reached, champion: wins[bracket.rounds.final[0].id] || null };
  }

  function score(p, scoring, actuals) {
    const per = {};
    let total = 0;
    for (const rd of scoring.rounds) {
      const hits = (p[rd.id] || []).filter((t) => actuals.reached[rd.id].has(t)).length;
      per[rd.id] = { hits, pts: hits * rd.points };
      total += per[rd.id].pts;
    }
    const champHit = actuals.champion && p.champion === actuals.champion;
    per.champion = { hits: champHit ? 1 : 0, pts: champHit ? scoring.champion.points : 0 };
    total += per.champion.pts;
    return { total, per };
  }

  function rank(rows) {
    rows.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    let lt = null, lr = 0;
    rows.forEach((r, i) => { if (r.total !== lt) { lr = i + 1; lt = r.total; } r.rank = lr; });
    return rows;
  }

  const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };

  async function main() {
    let bracket, scoring, results, picks;
    try {
      [bracket, scoring, results, picks] = await Promise.all([
        loadJSON("../data/bracket.json"), loadJSON("../data/scoring.json"),
        loadJSON("../data/results.json"), loadJSON("../data/picks.json"),
      ]);
    } catch (e) {
      const b = document.getElementById("cc-board");
      if (b) b.innerHTML = `<p style="padding:20px">Couldn't load data — serve this over http (it's running at the same origin as the live site).</p>`;
      return;
    }

    const actuals = deriveActuals(bracket, results);
    const withB = picks.participants.filter((p) => p.hasBracket);
    const pending = picks.participants.filter((p) => !p.hasBracket);

    const rows = rank(withB.map((p) => {
      const s = score(p, scoring, actuals);
      return { name: p.displayName, champion: p.champion, total: s.total, per: s.per };
    }));

    // Prize
    const prize = document.getElementById("cc-prize");
    if (prize && picks.prizePerPerson) {
      const players = picks.participants.length;
      const pot = (picks.prizePerPerson * players).toLocaleString("en-US");
      prize.innerHTML =
        `<span class="cc-prize-amt">$${pot}</span>` +
        `<span class="cc-prize-lbl">prize pool · $${picks.prizePerPerson} × ${players} players</span>`;
    }

    // Meta
    const meta = document.getElementById("cc-meta");
    if (meta) {
      const totalMatches = Object.values(bracket.rounds).reduce((n, r) => n + r.length, 0);
      const done = Object.keys(results.matchResults || {}).length;
      const champ = actuals.champion ? bracket.teams[actuals.champion] : null;
      meta.innerHTML = "";
      meta.appendChild(el("span", "cc-chip", `<b>${done}</b> / ${totalMatches} matches decided`));
      meta.appendChild(el("span", "cc-chip", `<b>${withB.length}</b> brackets in`));
      if (champ) meta.appendChild(el("span", "cc-chip cc-chip-champ", `Champion <b>${champ.flag} ${champ.name}</b>`));
    }

    // Board
    const board = document.getElementById("cc-board");
    if (board) {
      board.innerHTML = "";
      rows.forEach((r) => {
        const li = el("li", "cc-row");
        li.dataset.rank = r.rank;
        if (r.rank <= 3) li.dataset.top = r.rank;
        const champTeam = bracket.teams[r.champion];

        li.appendChild(el("span", "cc-rank", r.rank <= 3 ? MEDALS[r.rank - 1] : r.rank));
        li.appendChild(el("span", "cc-flag", champTeam ? champTeam.flag : "🎲"));

        const id = el("span", "cc-id");
        id.appendChild(el("span", "cc-name", r.name));
        id.appendChild(el("span", "cc-champ", `Champion: ${champTeam ? champTeam.name : "—"}`));
        li.appendChild(id);

        const bd = el("span", "cc-bd");
        for (const rd of scoring.rounds) {
          const c = r.per[rd.id];
          const badge = el("span", "cc-badge");
          badge.dataset.on = c.pts > 0;
          badge.innerHTML = `<i>${rd.short}</i>${c.pts}`;
          bd.appendChild(badge);
        }
        const cc = el("span", "cc-badge cc-badge-champ");
        cc.dataset.on = r.per.champion.pts > 0;
        cc.innerHTML = `<i>🏆</i>${r.per.champion.pts}`;
        bd.appendChild(cc);
        li.appendChild(bd);

        li.appendChild(el("span", "cc-total", r.total));
        board.appendChild(li);
      });
    }

    // Waiting
    const wait = document.getElementById("cc-waiting");
    if (wait) {
      wait.innerHTML = "";
      pending.forEach((p) => wait.appendChild(el("span", "cc-wait", p.displayName)));
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", main);
  else main();
})();
