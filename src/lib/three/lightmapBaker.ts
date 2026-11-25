import * as THREE from "three/webgpu";
import { LIVING_SCENE } from "@/config/interior";
import type { RoomSurfaceId } from "@/config/materials";
import type { BakeVariant, FurnitureItem, PartitionSegment, SceneConfig, SunConfig } from "@/config/sceneTypes";
import { hDeskLayout, partitionSolidSpans } from "./layoutGeometry";
import { getSurfaceFrames, surfacePoint, type SurfaceFrame } from "./roomSurfaces";

/**
 * 프로토타입용 간이 라이트맵 베이커(CPU, 해석적 근사).
 *
 * 실제 베이크(Blender Cycles 등)를 대신해 방 외곽 6면의 "간접광"만 계산한다.
 * 직접광은 실시간 조명이 담당하므로 여기서는 더하지 않는다(직접광 중복 방지).
 *
 * 변형(variant)
 *  - closed: 천장·벽이 닫힌 실내. 창을 통한 하늘빛, 창으로 들어온 햇빛의 바닥 반사, 램프 주변 반사
 *  - open:   천장 없는 조감도. 위쪽 하늘(면광원 근사)과 햇빛 받은 바닥의 반사
 * 공통: 방 모서리·가구·파티션 접촉부 차폐(AO 근사)
 *
 * 내부 파티션의 정확한 광선 차폐나 여러 방 사이의 광 전달은 계산하지 않는다(접촉 차폐만 근사).
 * 결과는 표면별 HalfFloat DataTexture(uv1 채널)로 반환한다. 배치·광원이 바뀌면 다시 베이크해야 한다.
 */

export type LightmapSet = Record<RoomSurfaceId, THREE.DataTexture>;

export interface BakeOptions {
  variant: BakeVariant;
  lampsOn: boolean;
  /** 이 변형을 쓰는 표시 모드의 태양 */
  sun: SunConfig;
}

interface Source {
  pos: THREE.Vector3;
  /** 면광원의 방출 방향. null이면 전방향 */
  normal: THREE.Vector3 | null;
  color: THREE.Vector3;
  softening: number;
}

interface Occluder {
  center: THREE.Vector3;
  half: THREE.Vector3;
  cos: number;
  sin: number;
  strength: number;
  radius: number;
  /** 조기 제외용 경계 반지름 */
  bound: number;
}

const tmp = new THREE.Vector3();

function linearColor(hex: string, scale = 1): THREE.Vector3 {
  const c = new THREE.Color(hex); // sRGB hex → Linear 작업 공간
  return new THREE.Vector3(c.r * scale, c.g * scale, c.b * scale);
}

function makeOccluder(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, rotRad: number, strength: number, radius: number): Occluder {
  const half = new THREE.Vector3(hx, hy, hz);
  return { center: new THREE.Vector3(cx, cy, cz), half, cos: Math.cos(rotRad), sin: Math.sin(rotRad), strength, radius, bound: half.length() };
}

function furnitureOccluders(items: FurnitureItem[], scene: SceneConfig): Occluder[] {
  const out: Occluder[] = [];
  for (const it of items) {
    if (it.bake?.occlude === false) continue;
    const rot = THREE.MathUtils.degToRad(it.rotationY ?? 0);
    const strength = it.bake?.strength ?? scene.bake.furnitureOcclusion.strength;
    const radius = it.bake?.radius ?? scene.bake.furnitureOcclusion.radius;
    const [w, h, d] = it.size;
    const [px, py, pz] = it.position;
    if (it.kind === "hDesk") {
      // H형: 두 데스크 + 중앙 수납부만 차폐(사이 좌석 공간은 열려 있음)
      const layout = hDeskLayout(it.size);
      const boxes = [
        ...layout.desks.map((dk) => ({ x: dk.x, w: layout.deskWidth, d })),
        { x: 0, w: layout.spine.width, d: layout.spine.depth },
      ];
      for (const b of boxes) {
        // 로컬 오프셋을 아이템 회전으로 변환(로컬 +x → (cos, -sin))
        const ox = b.x * Math.cos(rot);
        const oz = -b.x * Math.sin(rot);
        out.push(makeOccluder(px + ox, py + h / 2, pz + oz, b.w / 2, h / 2, b.d / 2, rot, strength, radius));
      }
      continue;
    }
    out.push(makeOccluder(px, py + h / 2, pz, w / 2, h / 2, d / 2, rot, strength, radius));
  }
  return out;
}

function partitionOccluders(partitions: PartitionSegment[], scene: SceneConfig): Occluder[] {
  const cfg = scene.bake.partitionOcclusion;
  if (!cfg) return [];
  const out: Occluder[] = [];
  for (const p of partitions) {
    const h = p.height ?? scene.room.height;
    const strength = p.kind === "glass" ? cfg.strength * 0.5 : cfg.strength;
    for (const span of partitionSolidSpans(p)) {
      const dx = span.b[0] - span.a[0];
      const dz = span.b[1] - span.a[1];
      const len = Math.hypot(dx, dz);
      const rot = Math.atan2(-dz / len, dx / len); // 로컬 +x가 선분 방향
      out.push(makeOccluder((span.a[0] + span.b[0]) / 2, h / 2, (span.a[1] + span.b[1]) / 2, len / 2, h / 2, p.thickness / 2, rot, strength, cfg.radius));
    }
  }
  return out;
}

/** 점과 회전된 박스(OBB) 사이 거리. 내부면 0 */
function distanceToOccluder(p: THREE.Vector3, o: Occluder): number {
  const dx = p.x - o.center.x;
  const dy = p.y - o.center.y;
  const dz = p.z - o.center.z;
  // Y축 회전의 역변환
  const lx = o.cos * dx - o.sin * dz;
  const lz = o.sin * dx + o.cos * dz;
  const qx = Math.max(Math.abs(lx) - o.half.x, 0);
  const qy = Math.max(Math.abs(dy) - o.half.y, 0);
  const qz = Math.max(Math.abs(lz) - o.half.z, 0);
  return Math.sqrt(qx * qx + qy * qy + qz * qz);
}

function isUnderOccluder(p: THREE.Vector3, occluders: Occluder[]): boolean {
  return occluders.some((o) => o.center.y - o.half.y < 0.05 && distanceToOccluder(new THREE.Vector3(p.x, o.center.y, p.z), o) === 0);
}

function buildSources(scene: SceneConfig, opts: BakeOptions, occluders: Occluder[]): Source[] {
  const { room, bake, lighting } = scene;
  const sources: Source[] = [];
  const frames = getSurfaceFrames(room);
  const sunPos = new THREE.Vector3(...opts.sun.position);
  const sunDir = new THREE.Vector3(...opts.sun.target).sub(sunPos).normalize();
  const sunColor = linearColor(opts.sun.color, opts.sun.intensity);

  if (opts.variant === "open") {
    // 천장 없는 모형: 위쪽 하늘을 격자 면광원으로 근사 + 햇빛 받은 바닥 전체의 반사
    const open = bake.openSky ?? { color: [0.85, 0.9, 1] as const, power: 0.9, grid: [6, 3] as const, floorBounce: 0.1 };
    const [gx, gz] = open.grid;
    const cellArea = (room.width / gx) * (room.depth / gz);
    const skyColor = new THREE.Vector3(...open.color).multiplyScalar(open.power * cellArea);
    const bounceColor = sunColor
      .clone()
      .multiply(new THREE.Vector3(...bake.sunBounce.albedo))
      .multiplyScalar(open.floorBounce * cellArea * Math.max(0, -sunDir.y));
    for (let i = 0; i < gx; i++) {
      for (let k = 0; k < gz; k++) {
        const x = -room.width / 2 + ((i + 0.5) / gx) * room.width;
        const z = -room.depth / 2 + ((k + 0.5) / gz) * room.depth;
        sources.push({ pos: new THREE.Vector3(x, room.height + 0.6, z), normal: new THREE.Vector3(0, -1, 0), color: skyColor, softening: bake.softening * 2 });
        sources.push({ pos: new THREE.Vector3(x, 0.01, z), normal: new THREE.Vector3(0, 1, 0), color: bounceColor, softening: bake.softening * 2 });
      }
    }
    return sources;
  }

  for (const o of room.openings.filter((op) => op.kind === "window")) {
    const frame = frames.find((f) => f.id === o.wall)!;
    // 1) 창을 통한 하늘빛
    const g = bake.sky.grid;
    const area = o.width * o.height;
    const power = (bake.sky.power * area) / (g * g);
    const color = new THREE.Vector3(...bake.sky.color).multiplyScalar(power);
    for (let i = 0; i < g; i++) {
      for (let j = 0; j < g; j++) {
        const su = o.center - o.width / 2 + ((i + 0.5) / g) * o.width;
        const sv = o.bottom + ((j + 0.5) / g) * o.height;
        sources.push({ pos: surfacePoint(frame, su, sv), normal: frame.normal.clone(), color, softening: bake.softening });
      }
    }

    // 2) 햇빛이 바닥에 맺힌 영역의 반사광
    if (sunDir.y < -0.05) {
      const corners = [
        [o.center - o.width / 2, o.bottom],
        [o.center + o.width / 2, o.bottom],
        [o.center + o.width / 2, o.bottom + o.height],
        [o.center - o.width / 2, o.bottom + o.height],
      ].map(([su, sv]) => {
        const c = surfacePoint(frame, su, sv);
        const t = c.y / -sunDir.y;
        return c.addScaledVector(sunDir, t);
      });
      const patchArea = Math.abs(
        new THREE.Vector3().subVectors(corners[1], corners[0]).cross(new THREE.Vector3().subVectors(corners[3], corners[0])).y,
      );
      const gs = bake.sunBounce.grid;
      const albedo = new THREE.Vector3(...bake.sunBounce.albedo);
      const bounce = sunColor.clone().multiply(albedo).multiplyScalar((bake.sunBounce.power * patchArea) / (gs * gs));
      const halfW = room.width / 2 - 0.02;
      const halfD = room.depth / 2 - 0.02;
      for (let i = 0; i < gs; i++) {
        for (let j = 0; j < gs; j++) {
          const a = (i + 0.5) / gs;
          const b = (j + 0.5) / gs;
          const bottom = corners[0].clone().lerp(corners[1], a);
          const top = corners[3].clone().lerp(corners[2], a);
          const p = bottom.lerp(top, b);
          if (Math.abs(p.x) > halfW || Math.abs(p.z) > halfD) continue; // 방 밖
          if (isUnderOccluder(p, occluders)) continue; // 가구에 가려진 영역
          p.y = 0.01;
          sources.push({ pos: p, normal: new THREE.Vector3(0, 1, 0), color: bounce, softening: bake.softening });
        }
      }
    }
  }

  // 3) 램프 반사광(램프 켜짐 변형)
  if (opts.lampsOn) {
    for (const lamp of lighting.lamps) {
      sources.push({
        pos: new THREE.Vector3(...lamp.position),
        normal: null,
        color: linearColor(lamp.color, lamp.intensity * bake.lampBounce.power),
        softening: bake.lampBounce.softening,
      });
    }
  }
  return sources;
}

function occlusionAt(p: THREE.Vector3, frame: SurfaceFrame, scene: SceneConfig, open: boolean, occluders: Occluder[]): number {
  const { room, bake } = scene;
  const W = room.width / 2;
  const D = room.depth / 2;
  const H = room.height;
  let occ = 1;
  const planes = [p.x + W, W - p.x, p.y, H - p.y, p.z + D, D - p.z];
  for (let i = 0; i < planes.length; i++) {
    const d = planes[i];
    if (open && i === 3) continue; // 천장 없음
    if (d < 1e-3) continue; // 자기 자신이 놓인 면
    occ *= 1 - bake.edgeOcclusion.strength * Math.exp(-d / bake.edgeOcclusion.radius);
  }
  for (const o of occluders) {
    tmp.copy(o.center).sub(p);
    const centerDist = tmp.length();
    if (centerDist - o.bound > o.radius * 6) continue; // 영향이 미미한 먼 차폐물
    const d = distanceToOccluder(p, o);
    // 표면이 차폐물 쪽을 향할 때만 차폐(반대편 면은 영향 없음)
    const facing = tmp.dot(frame.normal) > -0.05 ? 1 : 0;
    occ *= 1 - facing * o.strength * Math.exp(-d / o.radius);
  }
  return occ;
}

/** 표면 하나를 행 단위로 계산한다. ROWS_PER_STEP 행마다 멈춰(yield) 비동기 실행이 브라우저에 제어를 돌려줄 수 있게 한다. */
const ROWS_PER_STEP = 4;

function* bakeSurfaceSteps(frame: SurfaceFrame, scene: SceneConfig, open: boolean, sources: Source[], occluders: Occluder[]): Generator<void, THREE.DataTexture> {
  const { bake } = scene;
  const tpm = bake.texelsPerMeter;
  const w = Math.max(8, Math.ceil(frame.uLength * tpm));
  const h = Math.max(8, Math.ceil(frame.vLength * tpm));
  const data = new Uint16Array(w * h * 4);
  const p = new THREE.Vector3();
  const l = new THREE.Vector3();
  const ambient = bake.ambient;
  const n = frame.normal;

  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      surfacePoint(frame, ((i + 0.5) / w) * frame.uLength, ((j + 0.5) / h) * frame.vLength, p);
      let r = ambient[0];
      let g = ambient[1];
      let b = ambient[2];
      for (const s of sources) {
        l.subVectors(s.pos, p);
        const d2 = l.lengthSq();
        l.multiplyScalar(1 / Math.sqrt(d2));
        const cosR = n.dot(l);
        if (cosR <= 0) continue;
        const cosS = s.normal ? -s.normal.dot(l) : 1;
        if (cosS <= 0) continue;
        const f = (cosR * cosS) / (d2 + s.softening * s.softening);
        r += s.color.x * f;
        g += s.color.y * f;
        b += s.color.z * f;
      }
      // 계산값은 "흰색 표면의 출사 휘도" 근사이므로, three.js 라이트맵(조도) 규약에 맞춰 π를 곱한다.
      const occ = occlusionAt(p, frame, scene, open, occluders) * Math.PI;
      const k = (j * w + i) * 4;
      data[k] = THREE.DataUtils.toHalfFloat(r * occ);
      data[k + 1] = THREE.DataUtils.toHalfFloat(g * occ);
      data[k + 2] = THREE.DataUtils.toHalfFloat(b * occ);
      data[k + 3] = THREE.DataUtils.toHalfFloat(1);
    }
    if (j % ROWS_PER_STEP === ROWS_PER_STEP - 1) yield;
  }

  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.colorSpace = THREE.NoColorSpace; // 선형 조도 값
  tex.channel = 1; // uv1 사용
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.name = `lightmap:${scene.id}:${open ? "open" : "closed"}:${frame.id}`;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 장면의 6개 외곽 표면 라이트맵을 계산한다.
 * scene을 생략하면 기존 거실(닫힌 실내) 설정을 사용한다.
 */
export function bakeLightmaps(scene: SceneConfig = LIVING_SCENE, opts: BakeOptions = { variant: "closed", lampsOn: true, sun: scene.lighting.sun }): LightmapSet {
  const occluders = [...furnitureOccluders(scene.furniture, scene), ...partitionOccluders(scene.partitions, scene)];
  const open = opts.variant === "open";
  const sources = buildSources(scene, opts, occluders);
  const out = {} as LightmapSet;
  for (const frame of getSurfaceFrames(scene.room)) {
    const steps = bakeSurfaceSteps(frame, scene, open, sources, occluders);
    let r = steps.next();
    while (!r.done) r = steps.next();
    out[frame.id] = r.value;
  }
  return out;
}

/** 취소된 베이크(새 편집이 들어와 결과가 필요 없어짐) */
export class BakeCancelledError extends Error {
  constructor() {
    super("라이트맵 베이크 취소");
    this.name = "BakeCancelledError";
  }
}

export interface BakeControl {
  /** true면 다음 멈춤 지점에서 중단하고 BakeCancelledError를 던진다 */
  isCancelled: () => boolean;
  /** 한 번에 연속 계산할 최대 시간(ms). 넘으면 브라우저에 제어를 돌려준다. */
  budgetMs?: number;
}

const yieldToBrowser = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * bakeLightmaps와 같은 결과를 시간 조각으로 나눠 계산한다(메인 스레드 멈춤 완화, 취소 가능).
 * 취소되면 만든 텍스처를 해제하고 BakeCancelledError를 던진다.
 */
export async function bakeLightmapsAsync(scene: SceneConfig, opts: BakeOptions, ctl: BakeControl): Promise<LightmapSet> {
  const budget = ctl.budgetMs ?? 12;
  const occluders = [...furnitureOccluders(scene.furniture, scene), ...partitionOccluders(scene.partitions, scene)];
  const open = opts.variant === "open";
  const sources = buildSources(scene, opts, occluders);
  const out = {} as LightmapSet;
  const cancel = () => {
    Object.values(out).forEach((t) => t.dispose());
    throw new BakeCancelledError();
  };
  let sliceStart = performance.now();
  for (const frame of getSurfaceFrames(scene.room)) {
    const steps = bakeSurfaceSteps(frame, scene, open, sources, occluders);
    let r = steps.next();
    while (!r.done) {
      if (performance.now() - sliceStart > budget) {
        await yieldToBrowser();
        if (ctl.isCancelled()) cancel();
        sliceStart = performance.now();
      }
      r = steps.next();
    }
    out[frame.id] = r.value;
  }
  if (ctl.isCancelled()) cancel();
  return out;
}
