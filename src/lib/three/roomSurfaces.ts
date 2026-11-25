import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { ROOM } from "@/config/interior";
import type { RoomSurfaceId } from "@/config/materials";
import type { RoomConfig, WallId, WallOpening } from "@/config/sceneTypes";
import { applyMetricBoxUV } from "./geometry";

/**
 * 방 표면(바닥·천장·벽 4면)의 로컬 좌표계.
 * 지오메트리 생성과 라이트맵 베이크가 같은 좌표계를 사용해 UV(uv1)와 텍셀 위치가 일치하도록 한다.
 *
 * p(su, sv) = origin + uAxis * su + vAxis * sv   (su ∈ [0, uLength], sv ∈ [0, vLength], m 단위)
 * normal = uAxis × vAxis (실내를 향함)
 *
 * 모든 함수는 방 설정(room)을 인자로 받는다. 생략하면 기존 거실(ROOM)을 사용한다.
 * 관련 호출(표면·개구부·베이커·환경맵)은 같은 room을 함께 전달해야 좌표가 섞이지 않는다.
 */
export interface SurfaceFrame {
  id: RoomSurfaceId;
  origin: THREE.Vector3;
  uAxis: THREE.Vector3;
  vAxis: THREE.Vector3;
  normal: THREE.Vector3;
  uLength: number;
  vLength: number;
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export function getSurfaceFrames(room: RoomConfig = ROOM): SurfaceFrame[] {
  const W = room.width;
  const D = room.depth;
  const H = room.height;
  const up = v3(0, 1, 0);
  const frame = (id: RoomSurfaceId, origin: THREE.Vector3, uAxis: THREE.Vector3, vAxis: THREE.Vector3, uLength: number, vLength: number): SurfaceFrame => ({
    id,
    origin,
    uAxis,
    vAxis,
    normal: new THREE.Vector3().crossVectors(uAxis, vAxis).normalize(),
    uLength,
    vLength,
  });
  return [
    frame("floor", v3(-W / 2, 0, D / 2), v3(1, 0, 0), v3(0, 0, -1), W, D),
    frame("ceiling", v3(-W / 2, H, -D / 2), v3(1, 0, 0), v3(0, 0, 1), W, D),
    frame("north", v3(-W / 2, 0, -D / 2), v3(1, 0, 0), up, W, H),
    frame("south", v3(W / 2, 0, D / 2), v3(-1, 0, 0), up, W, H),
    frame("west", v3(-W / 2, 0, D / 2), v3(0, 0, -1), up, D, H),
    frame("east", v3(W / 2, 0, -D / 2), v3(0, 0, 1), up, D, H),
  ];
}

export function getSurfaceFrame(id: RoomSurfaceId, room: RoomConfig = ROOM): SurfaceFrame {
  const f = getSurfaceFrames(room).find((s) => s.id === id);
  if (!f) throw new Error(`Unknown surface: ${id}`);
  return f;
}

export function surfacePoint(frame: SurfaceFrame, su: number, sv: number, target = new THREE.Vector3()): THREE.Vector3 {
  return target.copy(frame.origin).addScaledVector(frame.uAxis, su).addScaledVector(frame.vAxis, sv);
}

/** 표면 로컬 좌표계(x = 벽 방향, y = 위, z = 실내 방향) → 월드 변환 행렬 */
export function frameMatrix(frame: SurfaceFrame, su = 0, sv = 0, sz = 0): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeBasis(frame.uAxis, frame.vAxis, frame.normal);
  m.setPosition(surfacePoint(frame, su, sv).addScaledVector(frame.normal, sz));
  return m;
}

export function openingsFor(wall: WallId, room: RoomConfig = ROOM): WallOpening[] {
  return room.openings.filter((o) => o.wall === wall);
}

/**
 * 표면 메시(한 면) 생성 — 거실 벽·바닥·천장, 사무실 바닥·천장.
 * - uv: 미터 단위(재질 텍스처 반복용)
 * - uv1: 0..1 정규화(라이트맵 전용 채널)
 * 벽은 빛샘을 막기 위해 바깥쪽으로 벽 두께만큼 확장한다(확장 영역은 다른 표면 뒤에 숨는다).
 */
export function createSurfaceGeometry(frame: SurfaceFrame, room: RoomConfig = ROOM): THREE.BufferGeometry {
  const isWall = frame.id !== "floor" && frame.id !== "ceiling";
  const t = isWall ? room.wallThickness : 0;
  const shape = new THREE.Shape();
  shape.moveTo(-t, -t);
  shape.lineTo(frame.uLength + t, -t);
  shape.lineTo(frame.uLength + t, frame.vLength + t);
  shape.lineTo(-t, frame.vLength + t);
  shape.closePath();

  if (isWall) {
    for (const o of openingsFor(frame.id as WallId, room)) {
      const hole = new THREE.Path();
      const u0 = o.center - o.width / 2;
      const u1 = o.center + o.width / 2;
      hole.moveTo(u0, o.bottom);
      hole.lineTo(u0, o.bottom + o.height);
      hole.lineTo(u1, o.bottom + o.height);
      hole.lineTo(u1, o.bottom);
      hole.closePath();
      shape.holes.push(hole);
    }
  }

  const shapeGeo = new THREE.ShapeGeometry(shape);
  const src = shapeGeo.getAttribute("position");
  const count = src.count;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const uv1 = new Float32Array(count * 2);
  const p = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const su = src.getX(i);
    const sv = src.getY(i);
    surfacePoint(frame, su, sv, p);
    positions.set([p.x, p.y, p.z], i * 3);
    normals.set([frame.normal.x, frame.normal.y, frame.normal.z], i * 3);
    uv.set([su, sv], i * 2);
    uv1.set([su / frame.uLength, sv / frame.vLength], i * 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(shapeGeo.getIndex());
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setAttribute("uv1", new THREE.BufferAttribute(uv1, 2));
  geo.computeBoundingSphere();
  shapeGeo.dispose();
  return geo;
}

/* ------------------------------ 두께가 있는 벽(사무실 외벽) ------------------------------ */

export interface WallSolidOptions {
  /** 표시 높이(조감도 단면이면 방 높이보다 낮다) */
  height: number;
  /** 모서리를 덮기 위해 양 끝을 벽 두께만큼 연장(북·남 벽) */
  extendEnds: boolean;
  capHeight?: number;
}

/**
 * 벽 두께가 있는 외벽 메시와 단면 상단(캡) 메시를 만든다.
 * - 창은 벽 안의 구멍, 바닥에 닿는 문은 외곽 윤곽을 잘라낸 홈으로 만든다(바닥에 걸친 hole로 인한 퇴화 형상 방지).
 * - 문이 벽 높이 이상이면(단면으로 낮춘 벽) 벽을 문 위치에서 분할한다.
 * - uv1은 방 높이 기준 0..1(라이트맵 베이크 좌표와 동일), uv는 미터 단위 박스 투영.
 */
export function createWallSolidGeometry(
  frame: SurfaceFrame,
  room: RoomConfig,
  { height, extendEnds, capHeight = 0.025 }: WallSolidOptions,
): { wall: THREE.BufferGeometry; caps: THREE.BufferGeometry } {
  const t = room.wallThickness;
  const L = frame.uLength;
  const ext = extendEnds ? t : 0;
  const openings = openingsFor(frame.id as WallId, room);

  const doors = openings
    .filter((o) => o.bottom <= 0.001)
    .map((o) => ({ u0: o.center - o.width / 2, u1: o.center + o.width / 2, top: o.height }))
    .sort((a, b) => a.u0 - b.u0);
  const windows = openings
    .filter((o) => o.bottom > 0.001 && o.bottom + o.height < height - 0.03)
    .map((o) => ({ u0: o.center - o.width / 2, u1: o.center + o.width / 2, v0: o.bottom, v1: o.bottom + o.height }));

  // 높이 전체를 가르는 문에서 벽을 분할
  const pieces: [number, number][] = [];
  let start = -ext;
  for (const d of doors) {
    if (d.top >= height - 0.02) {
      if (d.u0 > start) pieces.push([start, d.u0]);
      start = d.u1;
    }
  }
  pieces.push([start, L + ext]);

  const wallGeos: THREE.BufferGeometry[] = [];
  const capGeos: THREE.BufferGeometry[] = [];
  const toWorld = frameMatrix(frame);

  for (const [a, b] of pieces) {
    if (b - a < 0.01) continue;
    const shape = new THREE.Shape();
    shape.moveTo(a, 0);
    for (const d of doors) {
      if (d.top >= height - 0.02 || d.u1 <= a || d.u0 >= b) continue;
      shape.lineTo(d.u0, 0);
      shape.lineTo(d.u0, d.top);
      shape.lineTo(d.u1, d.top);
      shape.lineTo(d.u1, 0);
    }
    shape.lineTo(b, 0);
    shape.lineTo(b, height);
    shape.lineTo(a, height);
    shape.closePath();
    for (const w of windows) {
      if (w.u0 < a || w.u1 > b) continue;
      const hole = new THREE.Path();
      hole.moveTo(w.u0, w.v0);
      hole.lineTo(w.u0, w.v1);
      hole.lineTo(w.u1, w.v1);
      hole.lineTo(w.u1, w.v0);
      hole.closePath();
      shape.holes.push(hole);
    }

    const geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 1 });
    geo.translate(0, 0, -t); // 안쪽 면이 z = 0(실내 방향 +z)
    geo.clearGroups();
    const pos = geo.getAttribute("position");
    const uv1 = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) uv1.set([pos.getX(i) / L, pos.getY(i) / room.height], i * 2);
    geo.setAttribute("uv1", new THREE.BufferAttribute(uv1, 2));
    geo.applyMatrix4(toWorld);
    applyMetricBoxUV(geo);
    wallGeos.push(geo);

    const cap = new THREE.BoxGeometry(b - a, capHeight, t + 0.004);
    cap.translate((a + b) / 2, height + capHeight / 2, -t / 2);
    cap.applyMatrix4(toWorld);
    capGeos.push(cap);
  }

  // ExtrudeGeometry(비인덱스)끼리, BoxGeometry(인덱스)끼리 병합한다.
  const wall = mergeGeometries(wallGeos);
  const caps = mergeGeometries(capGeos);
  wallGeos.forEach((g) => g.dispose());
  capGeos.forEach((g) => g.dispose());
  wall.computeBoundingSphere();
  caps.computeBoundingSphere();
  return { wall, caps };
}
