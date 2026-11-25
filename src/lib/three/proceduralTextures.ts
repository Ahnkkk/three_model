import * as THREE from "three/webgpu";
import type { ProceduralTextureKind } from "@/config/materials";

/**
 * 프로토타입용 절차적 PBR 텍스처 생성기.
 * - 반복(tiling) 가능한 주기적 노이즈를 사용한다.
 * - 색상 맵은 sRGB, 거칠기 맵은 Linear(NoColorSpace)로 지정한다.
 * - DOM(canvas)을 쓰지 않고 DataTexture로 생성한다.
 */

export interface GeneratedMaps {
  map: THREE.DataTexture;
  roughnessMap: THREE.DataTexture;
}

/* --------------------------- 노이즈 유틸 --------------------------- */

function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;
const smooth = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const fract = (v: number) => v - Math.floor(v);

/** 주기(px, py)를 갖는 값 노이즈. 결과 0..1 */
function periodicNoise(x: number, y: number, px: number, py: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smooth(x - x0);
  const ty = smooth(y - y0);
  const a = hash2(mod(x0, px), mod(y0, py), seed);
  const b = hash2(mod(x0 + 1, px), mod(y0, py), seed);
  const c = hash2(mod(x0, px), mod(y0 + 1, py), seed);
  const d = hash2(mod(x0 + 1, px), mod(y0 + 1, py), seed);
  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
}

/** u,v ∈ [0,1) 에서 반복 가능한 fBm. fx, fy는 정수 기본 주파수. */
function fbm(u: number, v: number, fx: number, fy: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const m = 1 << o;
    sum += amp * periodicNoise(u * fx * m, v * fy * m, fx * m, fy * m, seed + o * 17);
    norm += amp;
    amp *= 0.5;
  }
  return sum / norm;
}

/* --------------------------- 텍스처 생성 --------------------------- */

type Rgb = [number, number, number];
type Sampler = (u: number, v: number) => { color: Rgb; rough: number };

function createDataTexture(data: Uint8Array, size: number, colorSpace: THREE.ColorSpace): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = colorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

function rasterize(size: number, sampler: Sampler): GeneratedMaps {
  const color = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const s = sampler(u, v);
      const i = (y * size + x) * 4;
      color[i] = Math.round(clamp01(s.color[0]) * 255);
      color[i + 1] = Math.round(clamp01(s.color[1]) * 255);
      color[i + 2] = Math.round(clamp01(s.color[2]) * 255);
      color[i + 3] = 255;
      const r = Math.round(clamp01(s.rough) * 255);
      rough[i] = r;
      rough[i + 1] = r; // three.js는 G 채널을 roughness로 사용
      rough[i + 2] = r;
      rough[i + 3] = 255;
    }
  }
  return {
    map: createDataTexture(color, size, THREE.SRGBColorSpace),
    roughnessMap: createDataTexture(rough, size, THREE.NoColorSpace),
  };
}

const mix3 = (a: Rgb, b: Rgb, t: number): Rgb => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const scale3 = (a: Rgb, s: number): Rgb => [a[0] * s, a[1] * s, a[2] * s];

/**
 * 바닥 마루(타일 2.4m 기준): u 방향으로 놓인 폭 0.15m × 길이 1.2m 판재 16줄.
 * 줄마다 이음 위치를 달리하고, 판재 간 색 차이는 작게, 결은 판재 길이 방향으로 둔다.
 */
function woodPlanks(seed: number): Sampler {
  const tile = 2.4;
  const rows = 16;
  const segs = 2;
  const plankW = tile / rows;
  const plankL = tile / segs;
  const light: Rgb = [0.76, 0.58, 0.4];
  const dark: Rgb = [0.6, 0.43, 0.28];
  const gap: Rgb = [0.25, 0.17, 0.11];
  return (u, v) => {
    const row = Math.floor(v * rows);
    const lv = v * rows - row;
    const s = u * segs + hash2(row, 0, seed);
    const seg = mod(Math.floor(s), segs);
    const lu = fract(s);
    const plank = hash2(row, seg, seed + 1);
    // 결: 판재마다 위상을 달리한 길쭉한 노이즈 + 나이테 줄무늬
    const warp = fbm(u, v, 3, rows, seed + 2, 3);
    const lines = 0.5 + 0.5 * Math.sin((lv * 3 + warp * 5 + plank * 9) * Math.PI * 2);
    const streak = fbm(u, v, 6, 192, seed + 4, 4);
    const fine = periodicNoise(u * 384, v * 768, 384, 768, seed + 3);
    let c = mix3(light, dark, plank * 0.45 + streak * 0.35 + lines * 0.2);
    c = scale3(c, 0.9 + streak * 0.14 + fine * 0.05);
    let r = 0.5 + streak * 0.3 + plank * 0.1;
    const edge = Math.min(lv, 1 - lv) * plankW; // 판재 가장자리까지 거리(m)
    const endEdge = Math.min(lu, 1 - lu) * plankL;
    if (edge < 0.0018 || endEdge < 0.0018) {
      c = gap;
      r = 0.95;
    } else if (edge < 0.004 || endEdge < 0.004) {
      c = scale3(c, 0.85); // 모서리 모따기 음영
    }
    return { color: c, rough: r };
  };
}

/** 목재 결(회색조). 재질 색상으로 수종을 표현한다. */
function woodGrain(seed: number): Sampler {
  return (u, v) => {
    // u 방향으로 흐르는 곧은 결(가는 줄무늬 + 길쭉한 노이즈)
    const warp = fbm(u, v, 2, 6, seed, 3);
    const ring = 0.5 + 0.5 * Math.sin((v * 64 + warp * 3) * Math.PI);
    const streak = fbm(u, v, 3, 96, seed + 5, 4);
    const t = ring * 0.35 + streak * 0.7;
    const g = 0.78 + t * 0.32;
    return { color: [g, g * 0.98, g * 0.95], rough: 0.4 + streak * 0.35 };
  };
}

function plaster(seed: number): Sampler {
  return (u, v) => {
    const n = fbm(u, v, 8, 8, seed, 5);
    const g = 0.95 + (n - 0.5) * 0.08;
    return { color: [g, g, g], rough: 0.85 + n * 0.15 };
  };
}

function fabric(seed: number): Sampler {
  return (u, v) => {
    const warpThread = 0.5 + 0.5 * Math.sin(u * Math.PI * 2 * 48);
    const weftThread = 0.5 + 0.5 * Math.sin(v * Math.PI * 2 * 48);
    const weave = (Math.floor(u * 48) + Math.floor(v * 48)) % 2 === 0 ? warpThread : weftThread;
    const n = fbm(u, v, 6, 6, seed, 3);
    const g = 0.82 + weave * 0.12 + (n - 0.5) * 0.12;
    return { color: [g, g, g], rough: 0.85 + weave * 0.1 };
  };
}

function marble(seed: number): Sampler {
  const base: Rgb = [0.93, 0.92, 0.9];
  const vein: Rgb = [0.5, 0.5, 0.52];
  return (u, v) => {
    const n = fbm(u, v, 3, 3, seed, 5);
    const s = Math.abs(Math.sin((u * 2 + v * 1 + n * 2.6) * Math.PI));
    const veinAmt = Math.pow(1 - s, 10) * 0.9 + Math.pow(1 - s, 60) * 0.4;
    const cloud = fbm(u, v, 5, 5, seed + 9, 4);
    const c = mix3(scale3(base, 0.96 + cloud * 0.06), vein, clamp01(veinAmt));
    return { color: c, rough: 0.12 + veinAmt * 0.18 + cloud * 0.08 };
  };
}

function rug(seed: number): Sampler {
  const cream: Rgb = [0.86, 0.81, 0.72];
  const terracotta: Rgb = [0.68, 0.4, 0.29];
  const slate: Rgb = [0.33, 0.39, 0.45];
  return (u, v) => {
    const wool = fbm(u, v, 64, 64, seed, 2);
    const bx = Math.min(u, 1 - u);
    const by = Math.min(v, 1 - v);
    const border = Math.min(bx, by);
    let c: Rgb = cream;
    if (border < 0.04) c = slate;
    else if (border < 0.06) c = cream;
    else if (border < 0.075) c = terracotta;
    else {
      const du = Math.abs(fract(u * 4) - 0.5);
      const dv = Math.abs(fract(v * 3) - 0.5);
      const diamond = du + dv;
      if (diamond < 0.12) c = terracotta;
      else if (Math.abs(diamond - 0.32) < 0.025) c = slate;
    }
    return { color: scale3(c, 0.9 + wool * 0.18), rough: 0.95 };
  };
}

function ceramic(seed: number): Sampler {
  return (u, v) => {
    const n = fbm(u, v, 8, 8, seed, 3);
    const speck = hash2(Math.floor(u * 256), Math.floor(v * 256), seed) > 0.985 ? 0.6 : 1;
    const g = (0.93 + (n - 0.5) * 0.1) * speck;
    return { color: [g, g, g], rough: 0.3 + n * 0.2 };
  };
}

function leaf(seed: number): Sampler {
  const a: Rgb = [0.16, 0.36, 0.14];
  const b: Rgb = [0.3, 0.5, 0.2];
  return (u, v) => {
    const n = fbm(u, v, 6, 6, seed, 4);
    const veins = Math.pow(1 - Math.abs(Math.sin(u * Math.PI * 8 + n * 2)), 16);
    const c = mix3(a, b, n);
    return { color: mix3(c, [0.45, 0.6, 0.3], veins * 0.5), rough: 0.55 + n * 0.2 };
  };
}

/** 루프 파일 카펫(회색조). 재질 색상으로 톤을 정한다. */
function carpet(seed: number): Sampler {
  return (u, v) => {
    const pile = periodicNoise(u * 256, v * 256, 256, 256, seed);
    const tuft = periodicNoise(u * 96, v * 96, 96, 96, seed + 1);
    const cloud = fbm(u, v, 6, 6, seed + 2, 3);
    const g = 0.86 + (pile - 0.5) * 0.18 + (tuft - 0.5) * 0.12 + (cloud - 0.5) * 0.1;
    return { color: [g, g, g], rough: 0.95 };
  };
}

/** 정사각 타일 4×4 + 줄눈(회색조) */
function tiles(seed: number): Sampler {
  const count = 4;
  return (u, v) => {
    const fu = fract(u * count);
    const fv = fract(v * count);
    const edge = Math.min(fu, 1 - fu, fv, 1 - fv);
    const id = hash2(Math.floor(u * count), Math.floor(v * count), seed);
    const n = fbm(u, v, 8, 8, seed + 3, 2);
    if (edge < 0.018) return { color: [0.72, 0.71, 0.69], rough: 1 };
    const g = 0.95 + (id - 0.5) * 0.04 + (n - 0.5) * 0.03;
    return { color: [g, g, g], rough: 0.6 + n * 0.2 };
  };
}

const GENERATORS: Record<ProceduralTextureKind, { size: number; make: (seed: number) => Sampler }> = {
  woodPlanks: { size: 1024, make: woodPlanks },
  woodGrain: { size: 512, make: woodGrain },
  plaster: { size: 256, make: plaster },
  fabric: { size: 256, make: fabric },
  marble: { size: 512, make: marble },
  rug: { size: 512, make: rug },
  ceramic: { size: 256, make: ceramic },
  leaf: { size: 256, make: leaf },
  carpet: { size: 512, make: carpet },
  tiles: { size: 512, make: tiles },
};

export function generateTexture(kind: ProceduralTextureKind, seed = 1, sizeScale = 1): GeneratedMaps {
  const gen = GENERATORS[kind];
  const size = Math.max(64, Math.round(gen.size * sizeScale));
  return rasterize(size, gen.make(seed));
}

/** 액자 그림(추상화) 텍스처 */
export function generateArtwork(seed: number, size = 256): THREE.DataTexture {
  const palette: Rgb[] = [
    [0.86, 0.55, 0.38],
    [0.27, 0.36, 0.42],
    [0.9, 0.82, 0.62],
    [0.55, 0.62, 0.52],
    [0.18, 0.2, 0.22],
  ];
  const shapes = Array.from({ length: 6 }, (_, i) => ({
    x: hash2(i, 1, seed),
    y: hash2(i, 2, seed),
    r: 0.12 + hash2(i, 3, seed) * 0.28,
    c: palette[Math.floor(hash2(i, 4, seed) * palette.length)],
    rect: hash2(i, 5, seed) > 0.5,
  }));
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      let c: Rgb = [0.94, 0.92, 0.87];
      for (const s of shapes) {
        const inside = s.rect
          ? Math.abs(u - s.x) < s.r * 0.6 && Math.abs(v - s.y) < s.r
          : (u - s.x) ** 2 + (v - s.y) ** 2 < s.r * s.r;
        if (inside) c = s.c;
      }
      const n = periodicNoise(u * 64, v * 64, 64, 64, seed);
      const i = (y * size + x) * 4;
      data[i] = Math.round(clamp01(c[0] * (0.95 + n * 0.08)) * 255);
      data[i + 1] = Math.round(clamp01(c[1] * (0.95 + n * 0.08)) * 255);
      data[i + 2] = Math.round(clamp01(c[2] * (0.95 + n * 0.08)) * 255);
      data[i + 3] = 255;
    }
  }
  const tex = createDataTexture(data, size, THREE.SRGBColorSpace);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/** 창밖 하늘·풍경(배경 전용, 비조명) */
export function generateSkyTexture(size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const zenith: Rgb = [0.45, 0.66, 0.92];
  const horizon: Rgb = [0.86, 0.91, 0.96];
  const hills: Rgb = [0.48, 0.58, 0.42];
  const trees: Rgb = [0.28, 0.4, 0.26];
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      let c = mix3(horizon, zenith, clamp01((v - 0.35) / 0.65));
      const cloud = fbm(u, v, 4, 2, 31, 5);
      if (v > 0.45) c = mix3(c, [1, 1, 1], clamp01((cloud - 0.55) * 3) * 0.7);
      const hillLine = 0.3 + fbm(u, 0, 3, 1, 41, 3) * 0.12;
      const treeLine = 0.22 + fbm(u, 0, 24, 1, 51, 3) * 0.1;
      if (v < hillLine) c = mix3(hills, horizon, clamp01((v - 0.15) / 0.3) * 0.3);
      if (v < treeLine) c = scale3(trees, 0.85 + fbm(u, v, 32, 16, 61, 2) * 0.3);
      const i = (y * size + x) * 4;
      data[i] = Math.round(clamp01(c[0]) * 255);
      data[i + 1] = Math.round(clamp01(c[1]) * 255);
      data[i + 2] = Math.round(clamp01(c[2]) * 255);
      data[i + 3] = 255;
    }
  }
  const tex = createDataTexture(data, size, THREE.SRGBColorSpace);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}
