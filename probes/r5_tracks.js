// Ablate the outpost ground's traffic record (aTrack -> 0) and diff, to measure
// how much of the frame actually carries a record of traffic.
const eng=g.engine, gl=eng.renderer.getContext();
eng.pipeline.enabled.autoExposure=false;
function grab(){ g.settle(6); const s=eng.renderer.getSize(new THREE.Vector3());
  const w=s.x|0,h=s.y|0; const px=new Uint8Array(w*h*4);
  gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,px); return {w,h,px}; }
const targets=[];
eng.scene.traverse(o=>{ const a=o.geometry&&o.geometry.getAttribute&&o.geometry.getAttribute('aTrack');
  if(a) targets.push({o,a,saved:a.array.slice()}); });
const A=grab();
for(const t of targets){ t.a.array.fill(0); t.a.needsUpdate=true; }
const B=grab();
for(const t of targets){ t.a.array.set(t.saved); t.a.needsUpdate=true; }
let n=0,strong=0,total=A.w*A.h,sum=0;
for(let i=0;i<total;i++){ const o=i*4;
  const d=Math.max(Math.abs(A.px[o]-B.px[o]),Math.abs(A.px[o+1]-B.px[o+1]),Math.abs(A.px[o+2]-B.px[o+2]));
  if(d>4){n++; sum+=d;} if(d>16) strong++; }
return { meshesWithTrack: targets.length,
  changedPct:+((n/total)*100).toFixed(2), strongPct:+((strong/total)*100).toFixed(2),
  meanDelta8bit:+(sum/Math.max(1,n)).toFixed(1) };
