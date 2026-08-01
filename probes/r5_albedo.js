// Is the distant massif near-white because of (a) haze, (b) sun angle, or
// (c) its own albedo? Ablate aerial perspective, then ablate the SUN.
// Rectangles hand-picked off the r6 PNGs and verified by eye.
const eng=g.engine, gl=eng.renderer.getContext();
eng.pipeline.enabled.autoExposure=false;
function grab(){ g.settle(6); const s=eng.renderer.getSize(new THREE.Vector3());
  const w=s.x|0,h=s.y|0; const px=new Uint8Array(w*h*4);
  gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,px); return {w,h,px}; }
const L=(p,i)=>(0.2126*p[i]+0.7152*p[i+1]+0.0722*p[i+2])/255;
function rect(A,x0,y0,w,h){ let s=0,n=0,r=0,b=0;
  for(let y=y0;y<y0+h;y++)for(let x=x0;x<x0+w;x++){const o=((A.h-1-y)*A.w+x)*4;
    s+=L(A.px,o); r+=A.px[o]; b+=A.px[o+2]; n++;}
  return {l:+(s/n).toFixed(4), rb:+(r/b).toFixed(3)}; }
const suns=[];
eng.scene.traverse(o=>{ if(o.isDirectionalLight) suns.push(o); });
const RECTS={
  outpost:{ massif:[340,250,200,100], sand:[200,930,250,100] },
  vista:  { massif:[850,300,200,100], sand:[520,640,220,70] },
};
const out={ nSuns:suns.length };
for(const shot of Object.keys(RECTS)){
  g.applyShot? g.applyShot(shot) : g.shot(shot);
  const R=RECTS[shot]; const rec={};
  const A=grab();
  eng.pipeline.enabled.aerial=false; const B=grab();
  const keep=suns.map(s=>s.intensity); suns.forEach(s=>s.intensity=0);
  const C=grab();
  suns.forEach((s,i)=>s.intensity=keep[i]); eng.pipeline.enabled.aerial=true;
  for(const [k,r] of Object.entries(R))
    rec[k]={ base:rect(A,...r), noAerial:rect(B,...r), noAerialNoSun:rect(C,...r) };
  rec.ratio_base=+(rec.massif.base.l/rec.sand.base.l).toFixed(3);
  rec.ratio_noAerial=+(rec.massif.noAerial.l/rec.sand.noAerial.l).toFixed(3);
  rec.ratio_ambientOnly=+(rec.massif.noAerialNoSun.l/rec.sand.noAerialNoSun.l).toFixed(3);
  out[shot]=rec;
}
return out;
