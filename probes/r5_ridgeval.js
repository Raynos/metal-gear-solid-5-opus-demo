// For each shot: find the skyline, sample terrain 12-60px BELOW it (distant
// ridge face), and compare to the near ground in the bottom sixth. Aerial
// perspective ablated so haze cannot explain the result.
const eng = g.engine; const gl = eng.renderer.getContext();
eng.pipeline.enabled.autoExposure = false;
function grab(){ g.settle(6);
  const s=eng.renderer.getSize(new THREE.Vector3()); const w=s.x|0,h=s.y|0;
  const px=new Uint8Array(w*h*4); gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,px); return {w,h,px}; }
const L=(p,i)=>(0.2126*p[i]+0.7152*p[i+1]+0.0722*p[i+2])/255;
const at=(A,x,y)=>{const o=((A.h-1-y)*A.w+x)*4; return {l:L(A.px,o), r:A.px[o],g:A.px[o+1],b:A.px[o+2]};};
function measure(A){
  // skyline per column: first y where luminance drops >0.10 vs 8px above
  let ridge=[], ground=[];
  for(let x=0;x<A.w;x+=4){
    let sky=-1;
    for(let y=10;y<A.h*0.75;y++){
      if(at(A,x,y).l - at(A,x,y-8).l < -0.10){ sky=y; break; }
    }
    if(sky<0) continue;
    for(let y=sky+12;y<sky+60 && y<A.h;y+=3) ridge.push(at(A,x,y));
  }
  for(let y=Math.round(A.h*0.86);y<A.h;y+=3) for(let x=0;x<A.w;x+=6) ground.push(at(A,x,y));
  const m=a=>a.reduce((s,v)=>s+v.l,0)/a.length;
  const rb=a=>a.reduce((s,v)=>s+v.r,0)/a.reduce((s,v)=>s+v.b,0);
  return { ridgeL:+m(ridge).toFixed(3), groundL:+m(ground).toFixed(3),
           ratio:+(m(ridge)/m(ground)).toFixed(3), stops:+Math.log2(m(ridge)/m(ground)).toFixed(2),
           ridgeRB:+rb(ridge).toFixed(3), groundRB:+rb(ground).toFixed(3), n:ridge.length };
}
const out={};
for(const shot of ['vista','ridge','outpost','ground']){
  g.applyShot ? g.applyShot(shot) : (g.shot && g.shot(shot));
  const A=grab();
  eng.pipeline.enabled.aerial=false; const B=grab(); eng.pipeline.enabled.aerial=true;
  out[shot]={ withAerial:measure(A), noAerial:measure(B) };
}
return out;
