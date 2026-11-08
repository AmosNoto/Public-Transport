// Ribbon geometry for route lines, built as plain arrays so it can run in a worker.
// Each chain becomes a strip: two vertices per point (one each side), each carrying its
// neighbours so the vertex shader can mitre the joins in screen space.

export interface Ribbon {
  pos: Float32Array;
  prev: Float32Array;
  next: Float32Array;
  side: Float32Array;
  route: Float32Array;
  index: Uint32Array;
}

export function buildRibbon(verts: Float32Array, chains: Uint32Array): Ribbon {
  let nv = 0, ni = 0;
  for (let c = 0; c < chains.length; c += 3) { nv += chains[c + 1] * 2; ni += (chains[c + 1] - 1) * 6; }
  const pos = new Float32Array(nv * 2), prev = new Float32Array(nv * 2), next = new Float32Array(nv * 2);
  const side = new Float32Array(nv), route = new Float32Array(nv);
  const index = new Uint32Array(ni);
  let v = 0, k = 0;
  for (let c = 0; c < chains.length; c += 3) {
    const start = chains[c], n = chains[c + 1], r = chains[c + 2];
    for (let i = 0; i < n; i++) {
      const p = (start + i) * 2, pp = (start + Math.max(0, i - 1)) * 2, pn = (start + Math.min(n - 1, i + 1)) * 2;
      for (let s = -1; s <= 1; s += 2) {
        pos[v * 2] = verts[p]; pos[v * 2 + 1] = verts[p + 1];
        prev[v * 2] = verts[pp]; prev[v * 2 + 1] = verts[pp + 1];
        next[v * 2] = verts[pn]; next[v * 2 + 1] = verts[pn + 1];
        side[v] = s; route[v] = r;
        v++;
      }
      if (i < n - 1) {
        const a = v - 2;
        index[k++] = a; index[k++] = a + 1; index[k++] = a + 2;
        index[k++] = a + 2; index[k++] = a + 1; index[k++] = a + 3;
      }
    }
  }
  return { pos, prev, next, side, route, index };
}
