// Route lines: thin filaments of coloured light. Each route chain is one continuous ribbon,
// widened in screen space with mitred joins, so the line has constant pixel width at any zoom,
// no gaps, and no overlap at joints (overlap would add light where nothing is shared).
// Drawn additively: where different routes share a corridor, light adds toward white.

import * as THREE from 'three';
import { COMMON, ROUTES } from '../engine/glsl.ts';
import type { SharedUniforms, LayerUniforms, CityUniforms } from '../engine/engine.ts';

export function routeLines(verts: Float32Array, chains: Uint32Array, u: SharedUniforms, lu: LayerUniforms, cu: CityUniforms, routeTex: THREE.Texture) {
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
      for (const s of [-1, 1]) {
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
  const g = new THREE.BufferGeometry();
  g.setAttribute('rel', new THREE.BufferAttribute(pos, 2));
  g.setAttribute('prevRel', new THREE.BufferAttribute(prev, 2));
  g.setAttribute('nextRel', new THREE.BufferAttribute(next, 2));
  g.setAttribute('side', new THREE.BufferAttribute(side, 1));
  g.setAttribute('route', new THREE.BufferAttribute(route, 1));
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
  g.setIndex(new THREE.BufferAttribute(index, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: { ...u, ...lu, ...cu, uRouteTex: { value: routeTex }, uWidth: { value: 2.2 }, uGain: { value: 0.5 } },
    transparent: true, side: THREE.DoubleSide, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: COMMON + ROUTES + /* glsl */ `
      attribute vec2 rel, prevRel, nextRel;
      attribute float side, route;
      uniform float uWidth, uAlpha, uBoost;
      varying vec3 vColor;
      varying float vAcross;
      vec2 screenOf(vec4 c) { return c.xy / c.w * uRes * 0.5; }
      void main() {
        vec4 rs = routeState(route);
        vec4 c = clipOf(rel);
        float vis = gVis * uAlpha;
        vColor = rs.rgb * rs.a * vis * uBoost;
        vec2 s = screenOf(c), sp = screenOf(clipOf(prevRel)), sn = screenOf(clipOf(nextRel));
        // Branch-free, division-safe directions (no NaN can reach a vertex).
        vec2 d0 = s - sp, d1 = sn - s;
        float l0 = length(d0), l1 = length(d1);
        vec2 u1 = mix(vec2(1.0, 0.0), d1 / max(l1, 1e-6), step(1e-4, l1));
        vec2 u0 = mix(u1, d0 / max(l0, 1e-6), step(1e-4, l0));
        u1 = mix(u0, u1, step(1e-4, l1));
        d0 = u0;
        vec2 t = u0 + u1;
        float lt = length(t);
        t = mix(u0, t / max(lt, 1e-6), step(1e-3, lt));
        vec2 n = vec2(-t.y, t.x);
        float miter = 1.0 / max(dot(n, vec2(-d0.y, d0.x)), 0.4);
        float halfW = uWidth * uDpr * 0.5 + 0.5;
        c.xy += n * side * halfW * miter / (uRes * 0.5) * c.w;
        vAcross = side;
        gl_Position = rs.a * vis > 0.001 ? c : vec4(2.0, 2.0, 2.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uGain;
      varying vec3 vColor;
      varying float vAcross;
      void main() {
        float p = exp(-vAcross * vAcross * 3.0); // soft filament: bright core, falling off across
        gl_FragColor = vec4(vColor * p * uGain, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  return mesh;
}
