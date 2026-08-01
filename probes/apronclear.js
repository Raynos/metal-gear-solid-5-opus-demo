// Does the apron surface actually stand above the ground it was built on?
// Sample its own vertices and compare against the terrain's own queries.
const t = g.world.terrain;
const apron = g.world.registry.rocks.apron;
const p = apron.geometry.attributes.position.array;
const n = p.length / 3;
const above = [];
let neg = 0;
let negSeat = 0;
const hist = {};
for (let i = 0; i < n; i += 7) {
  const x = p[i * 3]; const y = p[i * 3 + 1]; const z = p[i * 3 + 2];
  const h = t.heightAt(x, z);
  const d = y - h;
  above.push(d);
  if (d < 0) neg++;
  const s = t.seatHeightAt(x, z, 0);
  if (y < s) negSeat++;
  const b = Math.max(-4, Math.min(6, Math.round(d / 2)));
  hist[b] = (hist[b] || 0) + 1;
}
above.sort((a, b) => a - b);
const q = (f) => +above[Math.floor((above.length - 1) * f)].toFixed(2);
return {
  samples: above.length,
  belowHeightAtPct: +((neg / above.length) * 100).toFixed(1),
  belowDrawnPct: +((negSeat / above.length) * 100).toFixed(1),
  p05: q(0.05), p25: q(0.25), median: q(0.5), p75: q(0.75), p95: q(0.95), max: q(1),
  histBy2m: hist,
};
