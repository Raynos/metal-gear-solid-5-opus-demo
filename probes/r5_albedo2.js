// Same question, with a real terrain mask: hide the terrain, diff, and only
// measure pixels that actually ARE terrain. Then ablate haze, then the sun.
const eng=g.engine, gl=eng.renderer.getContext();
eng.pipeline.enabled.autoExposure=false;
function grab(){ g.settle(6); const s=eng.renderer.getSize(new THREE.Vector3());
  const w=s.x|0,h=s.y|0; const px=new Uint8Array(w*h*4);
  gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,px); return {w,h,px}; }
const L=(p,i)=>(0.2126*p[i]+0.7152*p[i+1]+0.0722*p[i+2])/255;
const terrain=[]; eng.scene.traverse(o=>{ if(o.isMesh&&/terrain|clipmap|ground/i.test(o.name||'')) terrain.push(o); });
const suns=[]; eng.scene.traverse(o=>{ if(o.isDirectionalLight) suns.push(o); });
function stat(A,mask,x0,y0,w,h){ let s=0,n=0,mx=0,R=0,B=0;
  for(let y=y0;y<y0+h;y++)for(let x=x0;x<x0+w;x++){ const i=(A.h-1-y)*A.w+x;
    if(!mask[i]) continue; const o=i*4; const l=L(A.px,o); s+=l; R+=A.px[o]; B+=A.px[o+2]; if(l>mx)mx=l; n++; }
  return n? {l:+(s/n).toFixed(4), rb:+(R/B).toFixed(3), max:+mx.toFixed(3), cov:+(n/(w*h)).toFixed(2)} : {l:null,cov:0}; }
const RECTS={
  outpost:{ massifNear:[60,240,220,110], massifMid:[980,300,200,90], sandSun:[1620,880,240,120] },
  vista:  { massifNear:[850,300,200,100], massifMid:[1450,380,200,90], sandSun:[520,640,220,70] },
};
const out={ terrainMeshes: terrain.map(t=>t.name), nSuns: suns.length };
for(const shot of Object.keys(RECTS)){
  g.applyShot? g.applyShot(shot) : g.shot(shot);
  const A=grab();
  terrain.forEach(t=>t.visible=false); const noTerr=grab(); terrain.forEach(t=>t.visible=true);
  const mask=new Uint8Array(A.w*A.h);
  for(let i=0;i<mask.length;i++){ const o=i*4;
    mask[i] = (Math.abs(A.px[o]-noTerr.px[o])+Math.abs(A.px[o+1]-noTerr.px[o+1])+Math.abs(A.px[o+2]-noTerr.px[o+2]))>10 ?1:0; }
  eng.pipeline.enabled.aerial=false; const B=grab();
  const keep=suns.map(s=>s.intensity); suns.forEach(s=>s.intensity=0); const C=grab();
  suns.forEach((s,i)=>s.intensity=keep[i]); eng.pipeline.enabled.aerial=true;
  const rec={};
  for(const [k,r] of Object.entries(RECTS[shot]))
    rec[k]={base:stat(A,mask,...r), noHaze:stat(B,mask,...r), ambientOnly:stat(C,mask,...r)};
  const rr=(a,b,f)=>+(rec[a][f].l/rec[b][f].l).toFixed(3);
  rec.SUMMARY={ massifNear_over_sand: { base:rr('massifNear','sandSun','base'),
    noHaze:rr('massifNear','sandSun','noHaze'), ambientOnly_albedoProxy:rr('massifNear','sandSun','ambientOnly') } };
  out[shot]=rec;
}
return out;
