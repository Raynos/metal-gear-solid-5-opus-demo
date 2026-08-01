from PIL import Image
import glob, os, math, statistics as st, sys
def stats(p):
    im = Image.open(p).convert('RGB'); w,h = im.size
    im = im.crop((int(w*.05), int(h*.05), int(w*.95), int(h*.90)))
    px = list(im.getdata())[::7]; n=len(px)
    R=sum(q[0] for q in px)/n; G=sum(q[1] for q in px)/n; B=sum(q[2] for q in px)/n
    lum=sorted(0.2126*r+0.7152*g+0.0722*b for r,g,b in px)
    def s2l(c):
        c/=255
        return c/12.92 if c<=0.04045 else ((c+0.055)/1.055)**2.4
    ylin=sorted(0.2126*s2l(r)+0.7152*s2l(g)+0.0722*s2l(b) for r,g,b in px)
    mx=[max(q) for q in px]
    sat=sum((max(q)-min(q))/max(max(q),1) for q in px)/n
    q=lambda v: lum[int(n*v)]; ql=lambda v: max(ylin[int(n*v)],1e-6)
    return dict(file=os.path.basename(p),RmB=R-B,meanL=sum(lum)/n,blk=lum[0],
        p01=q(0.001),p50=q(0.5),p999=q(0.999),
        hi230=100*sum(1 for m in mx if m>=230)/n, clip=100*sum(1 for m in mx if m>=254)/n,
        sat=100*sat, stops=math.log2(ql(0.999)/ql(0.001)))
rows=[stats(p) for p in sorted(glob.glob(sys.argv[1]))]
hdr=f"{'file':16}{'R-B':>7}{'meanL':>7}{'blk':>5}{'p0.1':>6}{'p50':>6}{'p99.9':>7}{'hi230%':>8}{'clip%':>7}{'sat%':>6}{'stops':>6}"
print(hdr); print('-'*len(hdr))
for r in rows:
    print(f"{r['file']:16}{r['RmB']:+7.1f}{r['meanL']:7.1f}{r['blk']:5.0f}{r['p01']:6.1f}{r['p50']:6.1f}{r['p999']:7.1f}{r['hi230']:8.2f}{r['clip']:7.2f}{r['sat']:6.1f}{r['stops']:6.2f}")
print()
print(f"{sys.argv[2] if len(sys.argv)>2 else 'MEDIAN'}:", {k: round(st.median([r[k] for r in rows]),2) for k in ['RmB','meanL','blk','p01','p50','p999','hi230','clip','sat','stops']})
