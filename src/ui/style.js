/**
 * style.js — the whole UI design system as one injected stylesheet.
 *
 * DESIGN DIRECTION (why it looks like this, so nobody "improves" it back to a
 * web page):
 *
 * MGSV's front end is an INSTRUMENT, not a poster. It is cold, typographic and
 * almost entirely negative space: thin uppercase grotesque at wide tracking,
 * hairline rules at fractional opacity, right-aligned monospace for anything
 * numeric, and no fills, no radii, no gradients on anything the player clicks.
 * The only saturated colour in the entire product is the alert state — which is
 * the point: when the screen goes red it means something.
 *
 * The signature element is the VIEWFINDER FRAME — a hairline rectangle inset
 * from the viewport with corner ticks that overshoot the corners. It is present
 * in the menu (inert, 14% bone) and in play (it carries the alert colour and the
 * damage flash), so the whole game reads as being seen through one instrument.
 * It is the one place boldness is spent; everything else stays quiet.
 *
 * Two typefaces, two jobs, no overlap:
 *   --sans  thin grotesque, uppercase, 0.22-0.42em tracking — labels and state
 *   --mono  system monospace — every number, bearing, count and readout
 * Numbers never appear in the sans face and words never appear in the mono
 * face. That split is what makes it read as telemetry rather than as branding.
 *
 * COST: everything animated here is transform/opacity only, except the boot
 * wordmark's tracking collapse which runs once. The HUD writes are throttled and
 * change-gated in Hud.js — see the note there.
 */

export const CSS = `
.ui {
  --sans: "Helvetica Neue", "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;

  /* Desaturated to match the world's khaki/blue-grey; nothing here is pure. */
  --bone:   #e7e5dd;
  --bone-2: #9c9c94;
  --bone-3: #5b5c57;
  --void:   #060708;

  --rule:     rgba(231, 229, 221, 0.14);
  --rule-mid: rgba(231, 229, 221, 0.26);
  --rule-hot: rgba(231, 229, 221, 0.62);

  /* The single interactive accent: cold pale sage, the colour of instrument
     glass. Deliberately low-chroma so the alert reds are the only real colour. */
  --sage: #a8c0b6;

  --calm:    #8e9a94;
  --caution: #d9a441;
  --alert:   #ce3a26;
  --evasion: #7b93a8;

  /* Non-lethal. Straight off the reference frames: the tranquilliser round's
     chip in MGSV's weapon block is a pale ice-cyan, and it is the only cool
     accent the real HUD carries. It exists here for exactly one 3-letter chip,
     which is the point — a colour that means one thing. */
  --tranq: #79c2d4;

  --inset: clamp(18px, 2.4vw, 44px);
  --gut:   clamp(20px, 3.2vw, 62px);

  position: absolute;
  inset: 0;
  font-family: var(--sans);
  color: var(--bone);
  font-weight: 200;
  -webkit-font-smoothing: antialiased;
  text-rendering: geometricPrecision;
  user-select: none;
  overflow: hidden;
}
.ui *, .ui *::before, .ui *::after { box-sizing: border-box; }
.ui[hidden] { display: none !important; }

/* ---------------------------------------------------------------- viewfinder */

.fr { position: absolute; inset: var(--inset); z-index: 1; pointer-events: none; }
.fr i {
  position: absolute;
  background: var(--fr-col, var(--rule));
  transition: background 260ms linear;
}
.fr .e-t, .fr .e-b { left: 0; right: 0; height: 1px; }
.fr .e-l, .fr .e-r { top: 0; bottom: 0; width: 1px; }
.fr .e-t { top: 0; } .fr .e-b { bottom: 0; }
.fr .e-l { left: 0; } .fr .e-r { right: 0; }

/* Corner ticks overshoot the frame by 9px — the detail that makes it read as an
   optical reticle rather than a border. */
.fr b {
  position: absolute;
  width: 26px; height: 26px;
  border: 0 solid var(--fr-col, var(--rule-mid));
  transition: border-color 260ms linear;
}
.fr .k-tl { top: -9px; left: -9px;  border-top-width: 1px; border-left-width: 1px; }
.fr .k-tr { top: -9px; right: -9px; border-top-width: 1px; border-right-width: 1px; }
.fr .k-bl { bottom: -9px; left: -9px;  border-bottom-width: 1px; border-left-width: 1px; }
.fr .k-br { bottom: -9px; right: -9px; border-bottom-width: 1px; border-right-width: 1px; }

/* Alert recolours the frame with a HARD CUT (no transition on the flash). */
.ui[data-alert="caution"] .fr { --fr-col: rgba(217, 164, 65, 0.46); }
.ui[data-alert="alert"]   .fr { --fr-col: rgba(206, 58, 38, 0.72); }
.ui[data-alert="evasion"] .fr { --fr-col: rgba(123, 147, 168, 0.56); }

/* ------------------------------------------------------------------- backdrop */

/* Only the left third is darkened, and only in the menu: the world behind is
   the backdrop, not wallpaper to be covered up. */
.scrim {
  position: absolute; inset: 0; z-index: 0; opacity: 0;
  transition: opacity 420ms linear, background 260ms linear;
  background:
    linear-gradient(100deg, rgba(6,7,8,0.90) 0%, rgba(6,7,8,0.68) 21%, rgba(6,7,8,0.13) 45%, rgba(6,7,8,0) 60%),
    linear-gradient(to top, rgba(6,7,8,0.42) 0%, rgba(6,7,8,0) 26%);
}
.ui[data-mode="menu"] .scrim { opacity: 1; }
/* Settings is a dense two-column readout: it needs the world quieter behind it
   than the masthead does, or the hairline controls sit on bare sunlit sand. */
.ui[data-mode="menu"][data-panel="settings"] .scrim {
  background: linear-gradient(100deg, rgba(6,7,8,0.94) 0%, rgba(6,7,8,0.88) 26%, rgba(6,7,8,0.34) 47%, rgba(6,7,8,0) 62%);
}

/* ----------------------------------------------------------------- main menu */

.menu {
  position: absolute;
  left: calc(var(--inset) + var(--gut));
  top: 0; bottom: 0;
  width: min(560px, 52vw);
  z-index: 2;
  display: flex; flex-direction: column; justify-content: center;
  gap: clamp(28px, 4.4vh, 56px);
  opacity: 0; visibility: hidden;
  transition: opacity 220ms linear, visibility 0s linear 220ms;
}
.ui[data-mode="menu"] .menu { opacity: 1; visibility: visible; transition-delay: 0s; }
.ui[data-panel="settings"] .menu { opacity: 0; visibility: hidden; transition-delay: 0s, 220ms; }

.eyebrow {
  display: flex; align-items: center; gap: 10px;
  font-size: 10px; letter-spacing: 0.34em; color: var(--bone-2);
  text-transform: uppercase; white-space: nowrap;
}
.eyebrow s { display: block; width: 26px; height: 1px; background: var(--rule-hot); text-decoration: none; }
.eyebrow em { font-style: normal; font-family: var(--mono); letter-spacing: 0.16em; color: var(--sage); }

.wordmark {
  margin: 14px 0 0;
  font-size: clamp(30px, 4.2vw, 62px);
  font-weight: 100;
  line-height: 0.94;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--bone);
}
.wordmark u { display: block; text-decoration: none; }
.wordmark u:last-child { color: var(--bone-2); }

.sub {
  margin-top: 16px; padding-top: 12px;
  border-top: 1px solid var(--rule);
  font-family: var(--mono);
  font-size: 9.5px; letter-spacing: 0.22em; color: var(--bone-3);
}

/* --- the option stack. Rows are rules, not buttons. --------------------- */

.stack { position: relative; border-top: 1px solid var(--rule); }

.caret {
  position: absolute; left: -22px; top: 0;
  width: 14px; height: 1px; background: var(--bone);
  transform: translateY(0);
  transition: transform 150ms cubic-bezier(0.2, 0, 0, 1), opacity 150ms linear;
  will-change: transform;
}
.stack[data-sel="-1"] .caret { opacity: 0; }

.row {
  position: relative; display: block; width: 100%;
  padding: 17px 0 16px;
  border: 0; border-bottom: 1px solid var(--rule);
  background: none; color: inherit; font: inherit; text-align: left;
  pointer-events: auto; cursor: pointer;
  transition: border-color 160ms linear;
}
.row:focus { outline: none; }
.row:focus-visible { outline: 1px solid var(--sage); outline-offset: 4px; }
.rl {
  display: block;
  font-size: clamp(13px, 1.05vw, 16px); font-weight: 200;
  letter-spacing: 0.34em; text-transform: uppercase;
  color: var(--bone-2);
  transition: color 160ms linear, letter-spacing 200ms cubic-bezier(0.2, 0, 0, 1);
}
.rd {
  display: block; margin-top: 7px;
  font-family: var(--mono); font-size: 9px; letter-spacing: 0.17em;
  color: var(--bone-2); opacity: 0.62;
  transition: opacity 180ms linear, color 180ms linear;
}
.row[data-on="1"] { border-bottom-color: var(--rule-hot); }
.row[data-on="1"] .rl { color: var(--bone); letter-spacing: 0.38em; }
.row[data-on="1"] .rd { opacity: 1; color: var(--sage); }

/* --- live telemetry readout: the menu reads the world it is standing on --- */

.tel {
  position: absolute; left: 0; bottom: clamp(22px, 4vh, 48px);
  display: flex; gap: 18px; flex-wrap: wrap;
  font-family: var(--mono); font-size: 9px; letter-spacing: 0.14em;
  color: var(--bone-2);
}
.tel span { display: inline-flex; gap: 6px; }
.tel span i { font-style: normal; color: rgba(168, 192, 182, 0.62); }

/* ------------------------------------------------------------------ settings */

.set {
  position: absolute;
  left: calc(var(--inset) + var(--gut));
  top: 0; bottom: 0;
  width: min(470px, 48vw);
  z-index: 2;
  display: flex; flex-direction: column; justify-content: center;
  opacity: 0; visibility: hidden;
  transition: opacity 220ms linear, visibility 0s linear 220ms;
}
.ui[data-mode="menu"][data-panel="settings"] .set { opacity: 1; visibility: visible; transition-delay: 0s; }

.set h2 {
  margin: 0 0 22px; font-size: 11px; font-weight: 200;
  letter-spacing: 0.42em; text-transform: uppercase; color: var(--bone);
}
.grp {
  margin-top: 22px; padding-top: 9px;
  border-top: 1px solid var(--rule);
  font-family: var(--mono); font-size: 8.5px; letter-spacing: 0.24em; color: var(--bone-3);
}
.grp:first-of-type { margin-top: 0; }

.opt {
  display: flex; align-items: center; justify-content: space-between; gap: 24px;
  width: 100%; padding: 11px 0 10px;
  border: 0; border-bottom: 1px solid var(--rule);
  background: none; color: inherit; font: inherit; text-align: left;
  pointer-events: auto; cursor: pointer;
}
.opt:focus { outline: none; }
.opt[data-on="1"] { border-bottom-color: var(--rule-mid); }
.ol {
  font-size: 11px; letter-spacing: 0.26em; text-transform: uppercase;
  color: var(--bone-2); white-space: nowrap;
  transition: color 140ms linear;
}
.opt[data-on="1"] .ol { color: var(--bone); }

/* Segmented control: hairline cells, one filled. No radius, no gradient.
   The cells carry their own plate — without it the unselected values vanish
   against sunlit sand the moment the backdrop moves under them. */
.seg { display: flex; border: 1px solid var(--rule-mid); background: rgba(6, 7, 8, 0.5); }
.seg u {
  display: block; padding: 5px 11px 4px;
  border-left: 1px solid var(--rule-mid);
  font-family: var(--mono); font-size: 9px; letter-spacing: 0.12em;
  color: var(--bone-2); text-decoration: none;
  transition: color 120ms linear, background 120ms linear;
}
.seg u:first-child { border-left: 0; }
.seg u[data-v="1"] { background: var(--bone); color: var(--void); }
.opt[data-on="1"] .seg { border-color: var(--rule-hot); }
.opt[data-on="1"] .seg u:not([data-v="1"]) { color: var(--bone-2); }

/* Slider: a 1px track, a 1px fill, a 12px tick for a handle. */
.sld { display: flex; align-items: center; gap: 14px; }
.sld .trk { position: relative; width: clamp(110px, 12vw, 170px); height: 12px; }
.sld .trk::before {
  content: ""; position: absolute; left: 0; right: 0; top: 50%;
  height: 1px; background: var(--rule-mid);
}
.sld .fil {
  position: absolute; left: 0; top: 50%; height: 1px;
  background: var(--bone-2); width: 0;
}
.sld .hnd {
  position: absolute; top: 0; width: 1px; height: 12px;
  background: var(--bone); transform: translateX(0);
}
.sld .val { font-family: var(--mono); font-size: 9px; letter-spacing: 0.1em; color: var(--bone-2); min-width: 34px; }
.opt[data-on="1"] .sld .fil { background: var(--sage); }

.hint {
  margin-top: 26px; padding-top: 10px; border-top: 1px solid var(--rule);
  font-family: var(--mono); font-size: 8.5px; letter-spacing: 0.18em; color: var(--bone-3);
}
.hint b { font-weight: 400; color: var(--bone-2); }

/* ----------------------------------------------------------------------- HUD */

.hud {
  position: absolute; inset: var(--inset); z-index: 2;
  opacity: 0; visibility: hidden;
  transition: opacity 300ms linear, visibility 0s linear 300ms;
}
.ui[data-mode="play"] .hud { opacity: 1; visibility: visible; transition-delay: 0s; }

/* The HUD floats over bare sunlit sand and over sky. Every glyph and every
   hairline therefore carries its own shadow — this is the one thing MGSV's HUD
   does that is easy to forget and impossible to read without. text-shadow costs
   no compositing layer, which a filter on the root would. */
.hud, .hud * { text-shadow: 0 1px 2px rgba(6, 7, 8, 0.9); }
.hud s, .hud .stn u::before, .hud .stn u::after { box-shadow: 0 1px 2px rgba(6, 7, 8, 0.75); }

/* --- compass strip ------------------------------------------------------ */

.cmp {
  position: absolute; left: 50%; top: 0; transform: translateX(-50%);
  width: min(460px, 44vw); height: 30px;
  opacity: var(--cmp-o, 0.34);
  transition: opacity 500ms linear;
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 14%, #000 86%, transparent);
          mask-image: linear-gradient(90deg, transparent, #000 14%, #000 86%, transparent);
  overflow: hidden;
}
/* A baseline under the ticks. Without it the strip is a scatter of marks with
   no shape, and over bright sky it stops registering as an instrument at all. */
.cmp::after {
  content: ""; position: absolute; left: 0; right: 0; bottom: 6px; height: 1px;
  background: rgba(231, 229, 221, 0.34);
}
.cmp .rib { position: absolute; top: 0; left: 0; height: 100%; will-change: transform; }
.cmp .rib s {
  position: absolute; bottom: 7px; width: 1px; background: var(--bone);
  height: 5px; text-decoration: none;
}
.cmp .rib s[data-m="1"] { height: 10px; background: var(--bone); }
.cmp .rib s[data-m="2"] { height: 12px; background: var(--bone); }
.cmp .rib s em {
  position: absolute; left: 50%; bottom: 13px; transform: translateX(-50%);
  font-style: normal; font-size: 10px; letter-spacing: 0.14em; color: var(--bone);
}
.cmp .obm {
  position: absolute; bottom: 3px; width: 8px; height: 8px; margin-left: -4px;
  border: 1px solid var(--sage); transform: rotate(45deg);
}

/* --- alert state: the most important element on screen ------------------ */

.alr {
  position: absolute; left: 50%; top: 52px;
  transform: translateX(-50%);
  display: flex; align-items: center; gap: 14px;
  opacity: 0;
}
/* No transition on the way IN — MGSV cuts. The fade is only on the way out. */
.ui[data-alert="caution"] .alr,
.ui[data-alert="alert"]   .alr,
.ui[data-alert="evasion"] .alr { opacity: 1; }
.ui[data-alert="calm"] .alr { opacity: 0; transition: opacity 900ms linear 400ms; }

.alr s { display: block; width: clamp(24px, 4vw, 60px); height: 1px; background: currentColor; text-decoration: none; }
.alr em {
  font-style: normal; font-size: clamp(15px, 1.5vw, 23px); font-weight: 200;
  letter-spacing: 0.52em; text-indent: 0.52em; text-transform: uppercase;
  color: currentColor;
  text-shadow: 0 0 14px rgba(6, 7, 8, 0.95), 0 1px 3px rgba(6, 7, 8, 0.95);
}
.ui[data-alert="caution"] .alr { color: var(--caution); }
.ui[data-alert="alert"]   .alr { color: var(--alert); }
.ui[data-alert="evasion"] .alr { color: var(--evasion); }

/* One-shot flash on any state change. Restarted from JS by re-adding .cut. */
.alr.cut em { animation: cut 260ms steps(4, end); }
@keyframes cut { 0%, 49% { opacity: 0.15; } 50%, 100% { opacity: 1; } }

/* --- detection ring -----------------------------------------------------

   The core feedback loop of the whole genre, so it gets the most structure of
   anything in the HUD — and still no fills beyond a 45%-black backing plate.

   .mk rotates to the true bearing; .mkl translates out to the ring radius
   and COUNTER-rotates by the same angle, so the block stands upright wherever
   it is on the ring. A rotated 8px mono label is unreadable, and the real
   game's markers are screen-aligned for exactly this reason.

   Reading top to bottom, which is the order the eye needs them in:
     range  mono, the number you act on
     glyph  an inverted triangle, MGSV's own hostile marker
     meter  fills left to right, coloured at the AI's own thresholds
     reason three or five letters saying what he is reacting to             */

.ring {
  position: absolute; left: 50%; top: 50%;
  width: 0; height: 0;
  --r: clamp(118px, 21vh, 210px);
}
.mk {
  position: absolute; left: 0; top: 0; will-change: transform;
  filter: drop-shadow(0 1px 2px rgba(6, 7, 8, 0.9));
  color: var(--bone-2);
}
.mkl {
  position: absolute; left: 0; top: 0;
  display: flex; flex-direction: column; align-items: center; gap: 3px;
  width: 76px; margin-left: -38px;
  transform: translateY(calc(-1 * var(--r))) rotate(var(--nr, 0deg));
  will-change: transform;
}
/* Range. Mono, small, and it is the only number on the ring. */
.mkl u {
  font-family: var(--mono); font-size: 9px; letter-spacing: 0.06em;
  color: currentColor; text-decoration: none;
}
/* The hostile glyph: an inverted triangle, apex down at the contact. */
.mkl s {
  display: block; width: 13px; height: 9px;
  background: currentColor; text-decoration: none;
  clip-path: polygon(0 0, 100% 0, 50% 100%);
}
/* The awareness meter. Horizontal so it reads as a bar filling toward
   certainty rather than as a second glyph. */
.mkl i {
  position: relative; display: block; width: 34px; height: 4px;
  border: 1px solid currentColor; background: rgba(6, 7, 8, 0.45);
  font-style: normal;
}
.mkl i::after {
  content: ""; position: absolute; inset: 1px auto 1px 1px;
  width: calc(var(--a, 0) * (100% - 2px)); background: currentColor;
}
.mkl em {
  font-style: normal; font-family: var(--mono); font-size: 8.5px;
  letter-spacing: 0.18em; color: currentColor; opacity: 0.85;
}

/* PROGRESSIVE DISCLOSURE, because six fully-labelled markers is a dashboard.
   Each tier earns one more piece of type, in the order the player needs it:

     trace     glyph + meter, at 42%. Something is happening over there.
     noticing  + the reason. What he is reacting to is the actionable part —
               it is the thing you can stop doing.
     alerted   + the range. Once he is committed, distance is the decision.
     seen      all of it, in alert red.                                       */
.mk[data-s="trace"] { opacity: 0.42; }
.mk[data-s="trace"] .mkl u, .mk[data-s="trace"] .mkl em,
.mk[data-s="noticing"] .mkl u { visibility: hidden; }
.mk[data-s="seen"] { color: var(--alert); }
.mk[data-s="alerted"] { color: var(--caution); }
.mk[data-s="noticing"] { color: var(--bone); }

/* The one repeating animation in the HUD, spent on the one moment that
   deserves it: a meter climbing fast that has not filled yet. */
.mk[data-urgent="1"] .mkl s { animation: mkpulse 620ms steps(2, end) infinite; }
@keyframes mkpulse { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0.25; } }

/* --- objective ticker --------------------------------------------------- */

.obj {
  position: absolute; left: 0; bottom: 0;
  display: flex; align-items: baseline; gap: 14px;
  opacity: var(--obj-o, 0.7); transition: opacity 500ms linear;
}
.obj b {
  font-weight: 400; font-family: var(--mono); font-size: 8.5px;
  letter-spacing: 0.24em; color: var(--sage);
}
.obj em {
  font-style: normal; font-size: 11px; letter-spacing: 0.3em;
  text-transform: uppercase; color: var(--bone);
}
.obj u { font-family: var(--mono); font-size: 9px; letter-spacing: 0.12em; color: var(--bone-2); text-decoration: none; }
.obj[data-done="1"] em { color: var(--bone-3); text-decoration: line-through; text-decoration-thickness: 1px; }

/* --- weapon plate -------------------------------------------------------

   The one place in this UI that carries a fill, and the reference frames are
   the reason: MGSV's weapon block sits on a translucent dark plate with a pale
   hairline border, bottom-right, because that corner of the screen is bright
   sunlit sand and hairline type alone does not survive there. Everything
   inside the plate is still hairlines and 9px mono.

   THE MAGAZINE COMB is the signature: one tick per round, spent ticks go dark.
   MGSV never draws a magazine as a number alone and neither does this.        */

.wpn {
  position: absolute; right: 0; bottom: 0; text-align: right;
  opacity: var(--wpn-o, 1); transition: opacity 500ms linear;
}
.wpl {
  min-width: 196px;
  padding: 7px 10px 8px;
  border: 1px solid rgba(231, 229, 221, 0.30);
  background: rgba(7, 9, 10, 0.52);
  /* A cut corner, bottom-left: the plate reads as a machined part rather than
     a rounded card, and it is the cheapest possible nod to the real block's
     notched frame. */
  clip-path: polygon(0 0, 100% 0, 100% 100%, 9px 100%, 0 calc(100% - 9px));
}
.wtop { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.wtop em {
  font-style: normal; font-size: 10.5px; letter-spacing: 0.24em;
  text-transform: uppercase; color: var(--bone); white-space: nowrap;
}
/* Ammo-type chip. MGSV writes the payload, not the calibre: ZZZ, DMG. */
.wtop i {
  font-style: normal; font-family: var(--mono); font-size: 8px;
  letter-spacing: 0.14em; padding: 1px 4px 0; color: var(--void);
}
.wtop i:empty { display: none; }
.wtop i[data-k="tranq"] { background: var(--tranq); }
.wtop i[data-k="lethal"] { background: var(--alert); color: var(--bone); }

/* Suppressor durability. A hairline track with a filled hairline over it —
   the same slider vocabulary the settings panel uses, at instrument scale. */
.sup { display: flex; align-items: center; gap: 7px; margin-top: 6px; }
.sup b { font-weight: 400; font-family: var(--mono); font-size: 7.5px; letter-spacing: 0.2em; color: var(--bone-3); }
.sup i {
  position: relative; flex: 1; height: 3px;
  border: 1px solid var(--rule-mid); font-style: normal;
}
.sup i::after {
  content: ""; position: absolute; inset: 0;
  width: var(--sup, 100%); background: var(--bone-2);
}
/* Nothing publishes suppressor wear, so the bar must not claim a full one. A
   hatch means "fitted, no reading" — an instrument that admits what it cannot
   measure, which a solid full bar does not. */
.sup i[data-v="?"]::after {
  width: 100%;
  background: repeating-linear-gradient(115deg, var(--bone-3) 0 2px, transparent 2px 5px);
}

.wbot { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin-top: 7px; }

.mag {
  position: relative; display: flex; align-items: flex-end; gap: 1.5px;
  min-height: 12px; padding-bottom: 2px; overflow: hidden;
}
.mag s {
  display: block; width: 2px; height: 11px; text-decoration: none;
  background: var(--bone); transition: background 90ms linear, height 90ms linear;
}
/* A spent round is not removed — it goes dark and stays in the comb, so the
   magazine's size is always legible and "two left" reads as a shape. */
.mag s[data-v="0"] { background: rgba(231, 229, 221, 0.17); height: 7px; }
/* Reloading is indeterminate: gameplay reports a boolean, not a duration, so
   the comb says "working" with a travelling highlight and does not invent a
   progress fraction it cannot know. */
.mag[data-rl="1"] s { background: rgba(231, 229, 221, 0.17); height: 7px; }
/* The sweep is sized as a fraction of the comb, not in pixels, so it reads the
   same on a 6-round magazine and a 30-round one. Transform-only: the travel is
   a percentage of the sweep's own width, so nothing here touches layout. */
.mag[data-rl="1"]::after {
  content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 40%;
  background: linear-gradient(90deg, transparent, rgba(231, 229, 221, 0.85), transparent);
  animation: magload 820ms linear infinite;
}
@keyframes magload { from { transform: translateX(-110%); } to { transform: translateX(300%); } }

.amo { font-family: var(--mono); letter-spacing: 0.02em; color: var(--bone); line-height: 1; white-space: nowrap; }
.amo b { font-size: clamp(17px, 1.5vw, 22px); font-weight: 400; }
.amo b[data-empty="1"] { color: var(--alert); }
.amo i { font-style: normal; font-size: 11px; color: var(--bone-3); margin: 0 2px; }
.amo u { font-size: 11px; text-decoration: none; color: var(--bone-2); }
.wmd { margin-top: 4px; font-family: var(--mono); font-size: 8px; letter-spacing: 0.2em; color: var(--bone-3); }
.wmd:empty { display: none; }

.stn { display: flex; justify-content: flex-end; gap: 7px; margin-bottom: 9px; }
/* Stance glyphs are drawn, not written: a standing bar, a bent bar, a flat bar. */
.stn u { display: block; width: 13px; height: 15px; position: relative; opacity: 0.22; text-decoration: none; }
.stn u::before { content: ""; position: absolute; background: var(--bone); }
.stn u[data-k="stand"]::before { left: 6px; top: 0; width: 1px; height: 15px; }
.stn u[data-k="crouch"]::before { left: 6px; top: 5px; width: 1px; height: 10px; }
.stn u[data-k="crouch"]::after { content: ""; position: absolute; left: 6px; top: 5px; width: 7px; height: 1px; background: var(--bone); }
.stn u[data-k="prone"]::before { left: 0; top: 12px; width: 13px; height: 1px; }
.stn u[data-v="1"] { opacity: 1; }

/* --- damage / health at the screen edge ---------------------------------

   No health bar. MGSV does not have one and it would be the single least
   diegetic thing on screen. Health is legible as three states of the frame
   itself, which is the instrument the whole game is seen through:

     hurt      a steady red edge, opacity tracking the wound
     critical  the same edge with a slow double pulse — a heartbeat, and the
               only looping animation outside the detection ring
     down      the edge holds at full while the fail card cuts in

   Recovery gets its own gesture rather than just the absence of one: the edge
   cools to bone and retracts once, so healing is an event you can see.        */

.dmg {
  position: absolute; inset: calc(-1 * var(--inset)); pointer-events: none;
  opacity: var(--hurt, 0);
  background: radial-gradient(ellipse 74% 72% at 50% 52%, rgba(150, 26, 14, 0) 62%, rgba(150, 26, 14, 0.62) 88%, rgba(104, 14, 7, 0.9) 100%);
  transition: opacity 700ms linear;
}
.hud[data-hp="critical"] .dmg { animation: pulse 1500ms cubic-bezier(0.4, 0, 0.6, 1) infinite; }
@keyframes pulse { 0%, 100% { opacity: var(--hurt, 0); } 22% { opacity: 1; } 34% { opacity: calc(var(--hurt, 0) * 0.72); } 48% { opacity: 0.92; } }

.dmg.heal { animation: heal 900ms cubic-bezier(0.2, 0, 0, 1); }
@keyframes heal {
  0%   { opacity: 0.5; background: radial-gradient(ellipse 74% 72% at 50% 52%, rgba(168, 192, 182, 0) 58%, rgba(168, 192, 182, 0.34) 88%, rgba(168, 192, 182, 0.42) 100%); }
  100% { opacity: 0;   background: radial-gradient(ellipse 96% 94% at 50% 52%, rgba(168, 192, 182, 0) 58%, rgba(168, 192, 182, 0.00) 88%, rgba(168, 192, 182, 0.00) 100%); }
}

/* The frame carries the wound too, so the state is readable even with the
   player's eye at screen centre. Alert still wins: what the garrison is doing
   outranks what your health is doing. */
.ui[data-alert="calm"][data-hp="hurt"] .fr { --fr-col: rgba(178, 44, 30, 0.52); }
.ui[data-hp="critical"] .fr, .ui[data-hp="down"] .fr { --fr-col: rgba(206, 58, 38, 0.85); }

.hit {
  position: absolute; inset: calc(-1 * var(--inset)); pointer-events: none;
  opacity: 0; background: radial-gradient(120% 90% at 50% 50%, transparent 42%, rgba(196, 44, 26, 0.75) 100%);
}
.hit.on { animation: hit 480ms cubic-bezier(0.1, 0, 0.2, 1); }
@keyframes hit { 0% { opacity: 1; } 100% { opacity: 0; } }

/* --- directional damage -------------------------------------------------

   A wedge at the bearing of whatever hit you. It shares the detection ring's
   geometry deliberately: the player is already reading bearings off that ring,
   so a hit lands in a coordinate system they have learnt. One shot, gone in
   under a second, and never more than four at once.                          */

.dir {
  position: absolute; left: 50%; top: 50%; width: 0; height: 0;
  --rd: clamp(118px, 21vh, 210px);
}
.dw { position: absolute; left: 0; top: 0; opacity: 0; will-change: transform; }
.dw::after {
  content: ""; position: absolute; left: -104px; top: calc(-1 * var(--rd) - 54px);
  width: 208px; height: 62px;
  background: radial-gradient(ellipse 50% 100% at 50% 100%, rgba(214, 62, 40, 0.92), rgba(214, 62, 40, 0) 72%);
}
.dw[data-k="near"]::after { background: radial-gradient(ellipse 50% 100% at 50% 100%, rgba(231, 229, 221, 0.5), rgba(231, 229, 221, 0) 72%); }
.dw.on { animation: wedge 760ms cubic-bezier(0.1, 0, 0.3, 1); }
.dw[data-k="near"].on { animation-duration: 420ms; }
@keyframes wedge { 0% { opacity: 1; } 18% { opacity: 0.9; } 100% { opacity: 0; } }

/* -------------------------------------------------------- cinematic cards */

.cin {
  position: absolute; inset: 0; z-index: 9;
  display: flex; align-items: center;
  padding-left: calc(var(--inset) + var(--gut));
  visibility: hidden;
}
.cin[data-card] { visibility: visible; }
.cin .plate {
  position: absolute; inset: 0; background: var(--void);
  opacity: 0; transition: opacity 620ms linear;
}
.cin[data-card] .plate { opacity: 1; transition-duration: 0ms; }
.cin[data-card][data-out="1"] .plate { opacity: 0; transition-duration: 700ms; }

.cin .card { position: relative; opacity: 0; }
.cin[data-card] .card { animation: cardin 520ms cubic-bezier(0.2, 0, 0, 1) 180ms both; }
.cin[data-card][data-out="1"] .card { animation: cardout 500ms linear both; }
@keyframes cardin  { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: none; } }
@keyframes cardout { from { opacity: 1; } to { opacity: 0; } }

/* THE BEAT OF SILENCE. On an end card the plate cuts to black on the frame the
   mission ends and then NOTHING happens for 900 ms. Every delay below is that
   beat plus a stagger. It is the whole gesture: the flourish games normally
   put here is what MGSV leaves out, and leaving it out is what makes the words
   land. Do not shorten these to make the card feel "responsive". */
.cin[data-card="accomplished"] .card,
.cin[data-card="failed"] .card { animation: none; opacity: 1; }
.cin[data-card="accomplished"] .ck, .cin[data-card="failed"] .ck { animation: rise 420ms cubic-bezier(0.2, 0, 0, 1) 900ms both; }
.cin[data-card="accomplished"] .ct, .cin[data-card="failed"] .ct { animation: track 900ms cubic-bezier(0.2, 0, 0, 1) 1080ms both; }
.cin[data-card="accomplished"] .cm, .cin[data-card="failed"] .cm { animation: rise 460ms cubic-bezier(0.2, 0, 0, 1) 1620ms both; }
.cin[data-card="accomplished"] .cp, .cin[data-card="failed"] .cp { animation: fade 500ms linear 2200ms both; }

.ck {
  display: flex; align-items: center; gap: 11px;
  font-family: var(--mono); font-size: 9px; letter-spacing: 0.3em; color: var(--bone-2);
  text-transform: uppercase;
}
.ck s { display: block; width: 30px; height: 1px; background: var(--rule-hot); text-decoration: none; }
.ct {
  margin: 15px 0 0;
  font-size: clamp(22px, 3.1vw, 46px); font-weight: 100;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--bone);
  animation: track 760ms cubic-bezier(0.2, 0, 0, 1) 180ms both;
}
@keyframes track { from { letter-spacing: 0.52em; opacity: 0; } to { letter-spacing: 0.2em; opacity: 1; } }
.cm {
  margin-top: 18px; padding-top: 11px; border-top: 1px solid var(--rule);
  font-family: var(--mono); font-size: 9px; letter-spacing: 0.2em; color: var(--bone-2);
  display: flex; gap: 22px; flex-wrap: wrap;
}
.cm span i { font-style: normal; color: var(--bone-3); margin-right: 7px; }
.cin[data-card="failed"] .ct { color: var(--alert); }

/* Key prompts. The end card holds until a decision, so the decisions have to
   be on it — in the same 9px mono as every other readout, keys boxed the way
   the settings panel boxes its values. */
.cp { margin-top: 26px; display: flex; gap: 24px; flex-wrap: wrap; }
.cp:empty { display: none; }
.cp span {
  display: inline-flex; align-items: center; gap: 9px;
  font-family: var(--mono); font-size: 9px; letter-spacing: 0.24em;
  text-transform: uppercase; color: var(--bone-2);
}
.cp b {
  font-weight: 400; padding: 3px 7px 2px;
  border: 1px solid var(--rule-mid); color: var(--bone);
  letter-spacing: 0.14em;
}

/* ------------------------------------------------------------ boot sequence */

/* The frame draws itself before anything else appears. */
.ui[data-boot="1"] .fr .e-t, .ui[data-boot="1"] .fr .e-b { animation: wipex 460ms cubic-bezier(0.2, 0, 0, 1) both; }
.ui[data-boot="1"] .fr .e-l, .ui[data-boot="1"] .fr .e-r { animation: wipey 460ms cubic-bezier(0.2, 0, 0, 1) 120ms both; }
.ui[data-boot="1"] .fr b { animation: fade 300ms linear 480ms both; }
@keyframes wipex { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes wipey { from { transform: scaleY(0); } to { transform: scaleY(1); } }
@keyframes fade  { from { opacity: 0; } to { opacity: 1; } }

.ui[data-boot="1"] .eyebrow { animation: rise 420ms cubic-bezier(0.2, 0, 0, 1) 420ms both; }
.ui[data-boot="1"] .wordmark { animation: track 900ms cubic-bezier(0.2, 0, 0, 1) 520ms both; }
.ui[data-boot="1"] .sub { animation: rise 420ms cubic-bezier(0.2, 0, 0, 1) 760ms both; }
.ui[data-boot="1"] .row:nth-child(2) { animation: rise 380ms cubic-bezier(0.2, 0, 0, 1) 900ms both; }
.ui[data-boot="1"] .row:nth-child(3) { animation: rise 380ms cubic-bezier(0.2, 0, 0, 1) 960ms both; }
.ui[data-boot="1"] .row:nth-child(4) { animation: rise 380ms cubic-bezier(0.2, 0, 0, 1) 1020ms both; }
.ui[data-boot="1"] .tel { animation: fade 500ms linear 1180ms both; }
@keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

@media (prefers-reduced-motion: reduce) {
  .ui *, .ui *::before, .ui *::after {
    animation-duration: 1ms !important;
    animation-delay: 0ms !important;
    transition-duration: 1ms !important;
  }
}
`;

/** Inject once. Idempotent so a hot reload does not stack stylesheets. */
export function injectStyle(doc = document) {
  let el = doc.getElementById('ui-style');
  if (!el) {
    el = doc.createElement('style');
    el.id = 'ui-style';
    doc.head.appendChild(el);
  }
  el.textContent = CSS;
  return el;
}
