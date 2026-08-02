"""Pretty-print the JSON from tools/probes/verify/m-printsweep.js."""
import json, sys, statistics as st
d = json.load(open(sys.argv[1]))
K = ['RmB', 'meanL', 'blk', 'p01', 'p50', 'p999', 'hi230', 'clip', 'sat', 'stops']
DAY = ['vista', 'ground', 'gameplay', 'outpost']
print(('%-16s' % '') + ''.join('%8s' % k for k in K))
print(('%-16s' % 'MGSV') + ''.join('%8.1f' % d['MGSV'][k] for k in K))
for lab, v in d['median'].items():
    print(('%-16s' % ('all7 ' + lab)) + ''.join('%8.1f' % v[k] for k in K))
for lab, shots in d['perShot'].items():
    m = {k: st.median([shots[s][k] for s in DAY if s in shots]) for k in K}
    print(('%-16s' % ('day  ' + lab)) + ''.join('%8.1f' % m[k] for k in K))
print()
for lab, shots in d['perShot'].items():
    print('--', lab)
    for s, v in shots.items():
        print(('%-16s' % s) + ''.join('%8.1f' % v[k] for k in K))
