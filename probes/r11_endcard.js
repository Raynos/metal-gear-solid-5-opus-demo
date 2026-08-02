/**
 * r11_endcard.js — does the grade actually reach the end card?
 *
 * probes/r11_mission.js proved gameplay PUBLISHES rank/summary/reason, and its
 * own line 5 says the UI drops them. That line is now a stale hardcoded string,
 * so this checks the thing itself rather than a sentence about it: drive the
 * mission to a win, then read the DOM the card actually renders.
 */
const g = window.__GAME;
const W = g.world;
const reg = W.registry;
const out = [];

const ui = reg.ui;
const gp = reg.gameplay;
if (!ui || !gp?.missionState) return { error: 'ui or gameplay missionState missing', ui: !!ui, gp: !!gp };

// The adapter first: it is what the card reads through.
const st = ui.mission?.src ?? ui.state ?? ui.uiState ?? null;
out.push(`adapter has missionOutcome(): ${typeof st?.missionOutcome === 'function'}`);
if (typeof st?.missionOutcome === 'function') {
  out.push(`  before the run: ${JSON.stringify(st.missionOutcome())}`);
}

// Win it the way the mission defines a win, rather than by setting `status`
// directly -- setting the field would prove only that a string propagates.
const m = gp.missionState;
const ctl = gp.controller ?? gp.player;
const site = m.site ?? { x: 0, z: 0 };
g.setMode('play');
m.begin();
ctl.position.set(site.x, ctl.position.y, site.z);
m.update(0.1);                                   // infil ticks inside the wire
m.accomplish('commander');                       // stand in for the kill
for (let i = 0; i < 3; i++) m.update(0.1);
out.push(`mission status: ${m.status} rank=${m.view.rank} reason=${m.view.reason}`);

if (typeof st?.missionOutcome === 'function') {
  out.push(`  adapter after the win: ${JSON.stringify(st.missionOutcome())}`);
}

// Let the UI tick so Mission.update() mirrors the result and builds the card.
for (let i = 0; i < 12; i++) g.engine.step(1 / 60);

// Read the CARD element, not the whole UI. Scoping matters: the first version
// of this probe matched /RANK/ against every character in #ui, with the main
// menu still mounted, and reported a pass it had not earned.
const card = ui.mission?.el ?? null;
const text = card ? (card.innerText || card.textContent || '').replace(/\s+/g, ' ').trim() : '(no card element)';
out.push(`card data-card attr: ${card ? card.getAttribute('data-card') : 'n/a'}`);
out.push(`card text: ${text.slice(0, 220)}`);
// innerText concatenates each meta label with its value and no separator, so
// the rank S renders as "RANKS" and a \bRANK\b match fails on a card that is
// working. Match the label followed by a value instead. (The loose version of
// this probe searched all of #ui and passed for the wrong reason; the strict
// one failed for the wrong reason. Both were wrong about the same card.)
const hasRank = /RANK\s*[SABC]\b/.test(text);
const hasResult = /RESULT\s*\S|CAUSE\s*\S/.test(text);
out.push(`RANK drawn on the card: ${hasRank}`);
out.push(`RESULT drawn on the card: ${hasResult}`);

return { checks: out, pass: hasRank && hasResult };
