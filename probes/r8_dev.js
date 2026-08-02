// ROUND 8. Why is the vista's near pan — the 60-240 m of ground between the
// camera and the compound, and the largest single surface in the establishing
// shot — completely bare?
//
// Suspicion: it is not the fertility field, it is `applyDevelopment`. The
// outpost's graded platform publishes a `dev` field with a 240 m apron, and this
// module answers it with `d * (1 - yard * 0.985)` wherever dev clears 0.40. If
// dev is still above 0.40 at 150-240 m then vegetation is being sterilised over
// a disc a quarter of a kilometre across, which is not what a FOB does to the
// rangeland outside its wire — that ground is driven over, not graded.
//
// Sample the actual fields along a radial from the compound.
const W = g.world;
const reg = W.registry ?? g.registry ?? {};
const veg = reg.vegetation;
const field = veg?.field ?? null;
if (!field) return { error: 'no veg field on registry', keys: Object.keys(reg) };

const rows = [];
for (const r of [0, 20, 40, 60, 80, 100, 130, 160, 200, 240, 300, 400, 600]) {
  // Along the vista's view ray from the compound toward the camera (+x +z).
  const x = r * 0.42, z = r * 0.91;
  const p = field.padAt(x, z, { lift: 0, dev: 0, shelter: 0 });
  const d = field.density(x, z);
  rows.push({
    r,
    dev: +p.dev.toFixed(3),
    shelter: +p.shelter.toFixed(3),
    grass: +d.density.toFixed(4),
    woody: +d.woody.toFixed(4),
    slope: +d.slope.toFixed(3),
    wet: +d.wet.toFixed(3),
    rock: +d.rock.toFixed(3),
  });
}
// And the same fields with development removed, to separate "the ground is dry"
// from "the compound sterilised it".
return { radial: rows };
