// Ablate aerial perspective; measure the distant mountain band.
const eng = g.engine;
const gl = eng.renderer.getContext();
eng.pipeline.enabled.autoExposure = false;
function grab(){ g.settle(6);
  const s=eng.renderer.getSize(new THREE.Vector3()); const w=s.x|0,h=s.y|0;
  const px=new Uint8Array(w*h*4); gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,px); return {w,h,px}; }
const lum=(p,i)=>(0.2126*p[i]+0.7152*p[i+1]+0.0722*p[i+2])/255;
// region in TOP-LEFT coords -> convert to gl bottom-up
function band(A, x0,y0,bw,bh){
  let s=0,n=0,mx=0,mn=1;
  for(let y=y0;y<y0+bh;y++) for(let x=x0;x<x0+bw;x++){
    const gy=A.h-1-y; const o=(gy*A.w+x)*4; const l=lum(A.px,o); s+=l;n++; if(l>mx)mx=l; if(l<mn)mn=l;
  }
  return {mean:+(s/n).toFixed(4),max:+mx.toFixed(3),min:+mn.toFixed(3)};
}
const A = grab();
eng.pipeline.enabled.aerial = false;
const B = grab();
eng.pipeline.enabled.aerial = true;
const sc = A.w/1920;
const R = (x,y,w,h)=>[Math.round(x*sc),Math.round(y*sc),Math.round(w*sc),Math.round(h*sc)];
const regions = { peakFar: R(340,250,200,100), peakMid: R(1000,300,200,90), nearGround: R(700,900,300,120) };
const out={size:[A.w,A.h]};
for(const [k,r] of Object.entries(regions)) out[k]={with:band(A,...r), without:band(B,...r)};
return out;
