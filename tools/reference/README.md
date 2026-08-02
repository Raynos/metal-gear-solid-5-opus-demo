# Measured reference: the real Metal Gear Solid V

Until now every critique in this project compared against *memory* of MGSV. This
directory replaces that with measurement.

## Getting the reference frames

Nine direct-feed 1920x1080 screenshots (the same resolution we render at):

```bash
for i in $(seq 1 9); do
  curl -sSL -A "Mozilla/5.0" -o "mgi-$i.jpg" \
    "https://www.metalgearinformer.com/wp-content/uploads/2015/06/Metal-Gear-Solid-V-The-Phantom-Pain-Screenshot-$i.jpg"
done
```

They are **not committed** — they are Konami's copyrighted images, kept locally as
rendering reference only. The *statistics derived from them* are below, and those
are facts.

## Measure ours the same way

```bash
python3 tools/reference/imagestats.py 'shots/r7/*.png' OURS
```

## The targets, measured across all nine reference frames (median)

| metric | MGSV | ours @r7 | note |
| --- | --- | --- | --- |
| warmth (mean R − mean B) | **+25.8** | +16.1 | we are too cold |
| mean luma | 127.6 | 123.8 | good |
| black point | **8.2** | 16.2 | ours 2x too high |
| p0.1 (deep shadow) | **18.4** | 31.7 | ours 1.7x too high |
| median | 111.1 | 129.7 | ours brighter |
| p99.9 | **254.0** | 245.3 | ours never reaches white |
| % pixels ≥ 230 | **9.7%** | 7.4% | ours under |
| % clipped (≥254) | **1.32%** | 0.00% | see below |
| saturation | **21.7%** | 15.4% | ours 29% under-saturated |
| dynamic range | **7.31 stops** | 6.00 | ours 1.3 stops short |

### Three of these correct decisions made earlier in this project

1. **The warmth target was wrong.** Rounds 3-4 reached R−B +34 and it was pulled
   back to a target of +8..+18 as "the orange-blockbuster look". The real game
   measures **+25.8**. +34 was hot; +8..+18 is too cold. Target **+22..+30**.
2. **Zero clipping was wrong.** Several rounds drove clipped pixels to exactly
   0.00% and treated that as a win. MGSV clips **1.32%** of pixels (up to 15% in
   a sun-facing frame). Highlights are supposed to blow out.
3. **The shadows are over-lifted.** After the pedestal fix the black point is
   16.2 against MGSV's 8.2, and p0.1 is 31.7 against 18.4. There is still a
   pedestal, roughly half the size of the one already removed.

Individual frames vary a lot — mgi-6 clips 15%, mgi-3 clips 0.01% — so treat the
median as the centre of a range, not a hard target. `vista.png` is our worst
frame on every axis (4.32 stops, 3.0% ≥230, black point 27).

## Fox Engine pipeline facts

From Adrian Courrèges' frame teardown, https://www.adriancourreges.com/blog/2017/12/15/mgs-v-graphics-study/

- **2,331 draw calls**, 623 textures, 73 render targets in one frame. Our
  350-draw-call budget is far stricter than the real game's; the budget should be
  frame *time*, not draw count.
- **Tone curve, exactly**: linear for `x <= 0.6`, then
  `min(1, A + B - B*B/(x - A + B))` with `A = 0.6`, `B = 0.45333`, per channel.
  We can implement the real curve rather than approximating it with ACES.
- **Deferred**, 4x B8G8R8A8 G-buffer: albedo+opacity / normal+roughness coeff /
  roughness+specular+material-id+SSS / 32-bit reversed depth.
- **Ambient is 2nd-order SH, 9 coefficients**, baked into a 16x16 tile atlas —
  the same technique we arrived at independently.
- **SSAO is a hybrid**: line-integral SSAO (5 taps) + scalable ambient obscurance
  (11 taps), both half-res, combined in a compute shader.
- **Diffuse GI at half resolution**, bilaterally upscaled against full-res depth.
- **FXAA, not TAA.** The real game does not use TAA. *(The claim that used to sit
  here — "our TAA measured as the most expensive pass" — was an artefact of the
  broken ruler: it timed the baseline once and each variant in sequence on a
  machine that drifts 2x within a run, so the drift was charged to whichever pass
  ran last. Re-measured with paired adjacent frames, the TAA blit is at or below
  the noise floor. See `tools/probes/README.md`.)*
- Bloom: 4 iterations of Kawase blur at quarter res, bright-pass keyed off HDR
  luminance stored in the alpha channel.
- DOF: sprite-scatter per pixel with CoC-sized disks, accumulated at 1/2, 1/4,
  1/8 and 1/16 resolution.
- Colour grade: **16x16x16 3D LUT** stored as 16 slices of 16x16 — exactly our
  layout.
- Shadows: 4096x4096 per light.

Sources:
- https://www.adriancourreges.com/blog/2017/12/15/mgs-v-graphics-study/
- https://www.metalgearinformer.com/metal-gear-solid-v-the-phantom-pain-direct-feed-screenshots/
