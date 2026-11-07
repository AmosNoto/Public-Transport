// Water: the only basemap content. Land is the scene background; water sits just darker,
// so geography reads faintly and never competes with the light.

import * as THREE from 'three';
import { COMMON } from '../engine/glsl.ts';
import type { SharedUniforms } from '../engine/engine.ts';

export function waterMesh(tri: Float32Array, u: SharedUniforms, off: THREE.Vector2, color: THREE.Color): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  g.setAttribute('rel', new THREE.BufferAttribute(tri, 2));
  // three needs a position attribute for bounds; the shader ignores it.
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((tri.length / 2) * 3), 3));
  const m = new THREE.ShaderMaterial({
    uniforms: { ...u, uOff: { value: off }, uColor: { value: color } },
    side: THREE.DoubleSide, depthTest: false, depthWrite: false,
    vertexShader: COMMON + /* glsl */ `
      attribute vec2 rel;
      void main() { gl_Position = clipOf(rel); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      void main() { gl_FragColor = vec4(uColor, 1.0); }`,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  return mesh;
}
