// Loads and prepares one city's geometry off the main thread, so flying into a city never
// stalls the animation. Returns transferable buffers ready for the GPU.

import { buildRibbon } from '../layers/ribbon.ts';

async function bin(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.arrayBuffer();
}

/** Pad RGBA float data to a whole number of texture rows. */
function pad(data: Float32Array, width: number): { data: Float32Array; height: number } {
  const height = Math.max(1, Math.ceil(data.length / 4 / width));
  const out = new Float32Array(width * height * 4);
  out.set(data);
  return { data: out, height };
}

self.onmessage = async (e: MessageEvent<{ req: number; id: string }>) => {
  const { req, id } = e.data;
  try {
    const res = await fetch(`/api/city/${id}`);
    if (!res.ok) throw new Error(`city ${id}: HTTP ${res.status}`);
    const meta = await res.json();
    const [pts, lines, chains] = await Promise.all(['points.bin', 'lines.bin', 'chains.bin'].map((f) => bin(`/api/city/${id}/${f}`)));
    const ribbon = buildRibbon(new Float32Array(lines), new Uint32Array(chains));
    const shapes = meta.shapes as { start: number; count: number; length: number; route: number }[];
    const tab = new Float32Array(shapes.length * 4);
    shapes.forEach((s, i) => { tab[i * 4] = s.start; tab[i * 4 + 1] = s.count; tab[i * 4 + 2] = s.length; tab[i * 4 + 3] = s.route; });
    const shapePts = pad(new Float32Array(pts), 2048), shapeTab = pad(tab, 1024);
    const transfer = [ribbon.pos, ribbon.prev, ribbon.next, ribbon.side, ribbon.route, ribbon.index, shapePts.data, shapeTab.data].map((a) => a.buffer);
    (self as unknown as Worker).postMessage({ req, ok: true, meta, ribbon, shapePts, shapeTab }, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ req, ok: false, error: (err as Error).message });
  }
};
