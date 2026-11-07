// Per-route colour and intensity on the GPU. Lines, photons and vehicles all read it, so a
// mode toggle or a hover is one small texture upload rather than touching instance buffers.

import * as THREE from 'three';
import type { CityData, Mode } from '../data/city.ts';

/**
 * Relative brightness by mode. Rapid transit reads as the bright rays; buses, far more
 * numerous and overlapping on shared streets, are finer, dimmer threads between them.
 */
export const MODE_WEIGHT: Record<Mode, number> = { subway: 1, tram: 0.9, rail: 0.8, bus: 0.3 };

export class RouteState {
  readonly texture: THREE.DataTexture;
  private data: Float32Array;
  /** Active vehicles per route, from the live stream. */
  readonly active: Uint16Array;

  constructor(private city: CityData) {
    const n = city.routes.length, h = Math.max(1, Math.ceil(n / 1024));
    this.data = new Float32Array(1024 * h * 4);
    this.active = new Uint16Array(n);
    this.texture = new THREE.DataTexture(this.data, 1024, h, THREE.RGBAFormat, THREE.FloatType);
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter;
  }

  update(modes: Record<Mode, boolean>) {
    const d = this.data;
    this.city.routes.forEach((r, i) => {
      const c = r.light;
      d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2];
      // Routes in service glow fully; routes with nothing running sit as faint outlines.
      d[i * 4 + 3] = modes[r.mode] ? MODE_WEIGHT[r.mode] * (this.active[i] > 0 ? 1 : 0.18) : 0;
    });
    this.texture.needsUpdate = true;
  }
}
