// Route lines: thin filaments of coloured light. Each route chain is one continuous ribbon,
// widened in screen space with mitred joins, so the line has constant pixel width at any zoom,
// no gaps, and no overlap at joints (overlap would add light where nothing is shared).
// Drawn additively: where different routes share a corridor, light adds toward white.

import * as THREE from 'three';
import { COMMON, ROUTES } from '../engine/glsl.ts';
import type { SharedUniforms, LayerUniforms, CityUniforms } from '../engine/engine.ts';
import type { Ribbon } from './ribbon.ts';

export function routeLines(r: Ribbon, u: SharedUniforms, lu: LayerUniforms, cu: CityUniforms, routeTex: THREE.Texture) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('rel', new THREE.BufferAttribute(r.pos, 2));
  g.setAttribute('prevRel', new THREE.BufferAttribute(r.prev, 2));
  g.setAttribute('nextRel', new THREE.BufferAttribute(r.next, 2));
  g.setAttribute('side', new THREE.BufferAttribute(r.side, 1));
  g.setAttribute('route', new THREE.BufferAttribute(r.route, 1));
  g.setIndex(new THREE.BufferAttribute(r.index, 1));
  // Positions come from the shader; give three a bound so it never needs a position attribute.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

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
