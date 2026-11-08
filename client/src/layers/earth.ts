// The dark Earth: a latitude/longitude grid in the same relative encoding as every other
// layer, so it wraps into the globe and unrolls into the map with them. Land is this mesh;
// water tiles draw over it. Day/night comes from the real sun position.
//
// The grid is built in longitudes relative to the focus (−π…π), so its seam always sits on
// the far side of the globe, and is re-centred each frame with uOff/uM0 like any layer.

import * as THREE from 'three';
import { COMMON, SUN } from '../engine/glsl.ts';
import type { SharedUniforms, LayerUniforms } from '../engine/engine.ts';
import { mercY, D2R } from '../engine/geo.ts';

const STEP = 1.5; // degrees per grid cell

export function earthMesh(u: SharedUniforms, lu: LayerUniforms, colors: { day: THREE.Color; night: THREE.Color; polarWater: THREE.Color; polarWaterNight: THREE.Color }) {
  const nx = Math.round(360 / STEP), ny = Math.round(179 / STEP);
  const rel = new Float32Array((nx + 1) * (ny + 1) * 2);
  let k = 0;
  for (let j = 0; j <= ny; j++) {
    const lat = (-89.5 + (179 * j) / ny) * D2R;
    for (let i = 0; i <= nx; i++) {
      rel[k++] = (-180 + (360 * i) / nx) * D2R;
      rel[k++] = mercY(lat);
    }
  }
  const index: number[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
    index.push(a, b, c, c, b, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('rel', new THREE.BufferAttribute(rel, 2));
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rel.length / 2 * 3), 3));
  g.setIndex(index);
  const m = new THREE.ShaderMaterial({
    uniforms: {
      ...u, ...lu,
      uDay: { value: colors.day }, uNight: { value: colors.night },
      uPolar: { value: colors.polarWater }, uPolarNight: { value: colors.polarWaterNight },
    },
    side: THREE.DoubleSide, depthTest: true, depthWrite: true,
    vertexShader: COMMON + /* glsl */ `
      attribute vec2 rel;
      varying vec2 vGeo;
      varying float vRim;
      void main() {
        vGeo = geoOf(rel);
        gl_Position = clipOf(rel);
        // Limb: the globe's edge catches a little light, so the night side still reads as a sphere.
        vRim = (1.0 - uMorph) * pow(1.0 - clamp(gFacing, 0.0, 1.0), 3.0);
      }`,
    fragmentShader: SUN + /* glsl */ `
      uniform vec3 uDay, uNight, uPolar, uPolarNight;
      varying vec2 vGeo;
      varying float vRim;
      void main() {
        float n = nightOf(vGeo);
        // Beyond the web-mercator limit no water tiles exist; the Arctic is ocean.
        bool polarSea = vGeo.y > 1.4844;
        vec3 c = polarSea ? mix(uPolar, uPolarNight, n) : mix(uDay, uNight, n);
        c += vec3(0.055, 0.075, 0.1) * vRim * (1.0 - 0.6 * n);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}
