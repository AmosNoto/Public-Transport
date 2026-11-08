// City glows for the globe view: points sampled along each city's real route network, in its
// route colours. From far away a city is a small cluster of coloured light; as the camera
// comes down, the detailed city fades in and the glow fades out.

import * as THREE from 'three';
import { COMMON, quadCorners } from '../engine/glsl.ts';
import type { SharedUniforms, LayerUniforms, CityUniforms } from '../engine/engine.ts';

export function cityGlow(samples: Float32Array, u: SharedUniforms, lu: LayerUniforms, cu: CityUniforms) {
  const g = new THREE.InstancedBufferGeometry();
  const q = quadCorners();
  g.setAttribute('position', new THREE.BufferAttribute(q.position, 3));
  g.setIndex(q.index);
  const n = samples.length / 5;
  const rel = new Float32Array(n * 2), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    rel[i * 2] = samples[i * 5]; rel[i * 2 + 1] = samples[i * 5 + 1];
    col[i * 3] = samples[i * 5 + 2]; col[i * 3 + 1] = samples[i * 5 + 3]; col[i * 3 + 2] = samples[i * 5 + 4];
  }
  g.setAttribute('aRel', new THREE.InstancedBufferAttribute(rel, 2));
  g.setAttribute('aCol', new THREE.InstancedBufferAttribute(col, 3));
  g.instanceCount = n;
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...u, ...lu, ...cu, uSize: { value: 2.6 }, uGain: { value: 1 } },
    transparent: true, side: THREE.DoubleSide, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: COMMON + /* glsl */ `
      attribute vec2 aRel;
      attribute vec3 aCol;
      uniform float uSize, uGain, uAlpha, uBoost;
      varying vec2 vUv; varying vec3 vColor;
      void main() {
        vec4 c = clipOf(aRel);
        float a = gVis * uAlpha;
        vColor = aCol * a * uGain * uBoost;
        vec2 corner = position.xy * vec2(2.0, 1.0) - vec2(1.0, 0.0);
        vUv = corner;
        c.xy += corner * uSize * uDpr * 0.5 / (uRes * 0.5) * c.w;
        gl_Position = a > 0.002 ? c : vec4(2.0, 2.0, 2.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vColor;
      void main() {
        float r = length(vUv);
        if (r > 1.0) discard;
        float a = r < 0.25 ? mix(1.0, 0.6, r / 0.25) : mix(0.6, 0.0, (r - 0.25) / 0.75);
        gl_FragColor = vec4(vColor * a, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  return mesh;
}
