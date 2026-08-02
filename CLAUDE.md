# Project rules

Read `ARCHITECTURE.md` for the working agreement, file ownership, module contract
and performance budget. The rules below are absolute and override convenience.

## Chromium and Playwright MUST be headless. Always.

`headless: false` is banned. So is `headless: 'new'` with a visible window, any
`--headed` flag, `chromium.launchPersistentContext` with a window, and anything
else that puts a browser window on screen.

This machine belongs to somebody who is using it. A headful browser steals focus,
pops windows over their work, and grabs the pointer. Several agents have done it
and it is not acceptable, however good the reason.

```js
// correct — the only launch this project uses
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
```

Headless still gets a **real GPU** here — `ANGLE Metal Renderer: Apple M3 Pro`,
not SwiftShader. You are not giving up rendering fidelity by staying headless.

### The one thing headless cannot do, and how to do it anyway

Headless chromium **refuses pointer lock**, and `src/core/Input.js` gates mouse
look on holding it. That gap is the only reason any probe ever needed a headful
window: a headless run could press keys but never turn the camera.

It is fixed. Turn on automation mode and raw `mousemove` deltas drive look with
no pointer lock required:

```js
await page.evaluate(() => window.__GAME.setAutomation(true));
await page.mouse.move(960, 540);
await page.mouse.move(1100, 540);   // camera turns
```

This changes nothing for a human — a real player still takes pointer lock on
click. If you find another capability that genuinely requires a window, fix the
engine so it does not, and write down what you did. Do not launch a window.

## Prefer the harness over your own browser

`tools/render.mjs` already owns launching, bundling, serving, GPU flags and hard
process-tree cleanup. Use it before writing your own driver:

```bash
node tools/shot.mjs vista ground gameplay --out shots/mine   # batch — see below
node tools/shot.mjs eval probe.js [args]                     # probe the live page
node tools/bench.mjs --quick                                 # benchmark the loop
```

Each invocation costs roughly 2 s to bundle plus 4.5 s to build the world, then
about 0.6 s per shot. **Ask for every shot you want in one command.** Seven
separate invocations cost seven world builds.

## The render daemon: one, from main, in a herdr pane

There is ONE daemon. It runs from the MAIN tree, in its own herdr pane, where it
is visible and somebody owns it:

```bash
node tools/shotd.mjs --idle 600
```

**Clients never start it.** They connect or they tell you to. That rule exists
because silent spawning destroyed the previous daemon: whichever checkout ran a
client first became the daemon's CODE, six of seven worktrees carried stale
copies, and a concurrency fix, a cap fix and an entire metrics layer were
silently not running for hours while the logs looked healthy. It was found by
printing the daemon's own argv.

So the daemon publishes the hash of its own source, and a client whose tree
differs is refused with a diagnosis rather than served stale behaviour.

It exits after 10 minutes idle, so leaving it running costs nothing. It evicts
resident worlds on MEASURED memory (`--mem`, default 6 GB) rather than a guessed
world count — guessing went 3 (continuous eviction, 138 rebuilds in a session),
then 10 (10.5 GB), then 5, all blind. A world is ~1.7 GB once GPU resources
count, which its 0.15 GB JS heap does not show.

## The machine is SHARED. Never blanket-kill.

Several authors run against this machine at once. `pkill -f chrome-headless-shell`,
`pkill -f vite` and anything else that matches by pattern will kill other people's
in-flight work, and they will see it as an unexplained "Target page has been
closed" with no cause they can find. One agent did this twice before noticing the
other worktrees in the process list.

Kill only what you started, by pid, from the handle you hold:

```js
const pid = browser.process?.()?.pid;
await browser.close();
try { process.kill(-pid, 'SIGKILL'); } catch {}
```

`tools/render.mjs` already does this correctly — prefer it over your own driver.
Before assuming a process is a leak, check whether it belongs to somebody else:

```bash
ps -o args= -p <pid> | grep -o '\.claude/worktrees/[^/]*'
```

## Clean up your processes

A headless chromium is a process *tree* — zygote, GPU process, renderers.
`browser.close()` alone has left 18 of them behind across seven runs and driven
the machine to load 20. Kill the process group, and verify:

```bash
pgrep -f chrome-headless-shell | wc -l    # must be 0 when you are done
```

## Measure before you claim

Every performance number in this project has been wrong at least once: a budget
that timed enqueued frames and reported 2.7 ms for a 40 ms frame; a screenshot
path rendering 54 frames per photo; ablation flags that gated nothing; a GPU
timer query 6x off; same-build frame diffs noisier than the effects being
measured. For any claim about performance, lighting or a post effect, use
ablation or a controlled probe, state the noise floor, and report "below noise"
rather than a number the instrument cannot resolve.
