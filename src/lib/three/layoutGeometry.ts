import type { FurnitureItem, PartitionSegment, Vec2, Vec3 } from "@/config/sceneTypes";

/**
 * 장면 공용 평면 기하(가구 footprint·벽 선분·H형 데스크 구성).
 * 3D 모델·2D 평면도·충돌·베이크·배치 검증이 함께 쓰며, three.js와 특정 장면 데이터에 의존하지 않는다.
 */

/* ------------------------------ H형 데스크 ------------------------------ */

export interface HDeskLayout {
  deskWidth: number;
  /** 두 평행 데스크(로컬 x 중심, outer = 바깥쪽 방향 부호) */
  desks: { x: number; outer: -1 | 1 }[];
  /** 중앙 연결 수납부 */
  spine: { width: number; depth: number };
  /** 좌석(로컬) */
  seats: { x: number; z: number; rotationY: number }[];
  /** 좌석마다 하나씩 놓는 모니터·키보드(로컬) */
  monitors: { x: number; z: number; rotationY: number; keyboardX: number }[];
}

/** H형 한 세트의 구성. 3D 모델과 2D 평면도가 같은 값을 쓴다. */
export function hDeskLayout(size: Vec3): HDeskLayout {
  const [w, , d] = size;
  const deskWidth = 0.78;
  const deskX = w / 2 - deskWidth / 2;
  const gap = w - deskWidth * 2;
  const seatX = gap / 2 - 0.34;
  const seatZ = d * 0.27;
  const seats = [
    { x: -seatX, z: -seatZ, rotationY: -90 },
    { x: -seatX, z: seatZ, rotationY: -90 },
    { x: seatX, z: -seatZ, rotationY: 90 },
    { x: seatX, z: seatZ, rotationY: 90 },
  ];
  return {
    deskWidth,
    desks: [
      { x: -deskX, outer: -1 },
      { x: deskX, outer: 1 },
    ],
    spine: { width: gap, depth: 0.42 },
    seats,
    monitors: seats.map((s) => {
      const side = Math.sign(s.x); // -1: 왼쪽 데스크, +1: 오른쪽 데스크
      return {
        x: side * (w / 2 - 0.2),
        z: s.z,
        // 모니터 화면이 좌석(안쪽)을 향하도록
        rotationY: side < 0 ? 90 : -90,
        keyboardX: side * (w / 2 - 0.5),
      };
    }),
  };
}

/* ------------------------------ 회전 사각형(OBB) ------------------------------ */

export interface Obb {
  cx: number;
  cz: number;
  hx: number;
  hz: number;
  ax: Vec2; // 로컬 x축(월드)
  az: Vec2; // 로컬 z축(월드)
}

export function footprintObb(item: Pick<FurnitureItem, "position" | "size" | "rotationY">, shrink = 0): Obb {
  const t = ((item.rotationY ?? 0) * Math.PI) / 180;
  return {
    cx: item.position[0],
    cz: item.position[2],
    hx: Math.max(0.001, item.size[0] / 2 - shrink),
    hz: Math.max(0.001, item.size[2] / 2 - shrink),
    // three.js Y축 회전: 로컬 +x → (cos, -sin), 로컬 +z → (sin, cos)
    ax: [Math.cos(t), -Math.sin(t)],
    az: [Math.sin(t), Math.cos(t)],
  };
}

export function segmentObb(a: Vec2, b: Vec2, thickness: number): Obb {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len = Math.hypot(dx, dz);
  return { cx: (a[0] + b[0]) / 2, cz: (a[1] + b[1]) / 2, hx: len / 2, hz: thickness / 2, ax: [dx / len, dz / len], az: [-dz / len, dx / len] };
}

/** 축 정렬 사각형(월드 [x0, z0, x1, z1]) → OBB */
export function rectObb(x0: number, z0: number, x1: number, z1: number): Obb {
  return { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, hx: Math.abs(x1 - x0) / 2, hz: Math.abs(z1 - z0) / 2, ax: [1, 0], az: [0, 1] };
}

export function obbOverlap(a: Obb, b: Obb): boolean {
  const axes = [a.ax, a.az, b.ax, b.az];
  const d: Vec2 = [b.cx - a.cx, b.cz - a.cz];
  const dot = (p: Vec2, q: Vec2) => p[0] * q[0] + p[1] * q[1];
  for (const axis of axes) {
    const ra = a.hx * Math.abs(dot(a.ax, axis)) + a.hz * Math.abs(dot(a.az, axis));
    const rb = b.hx * Math.abs(dot(b.ax, axis)) + b.hz * Math.abs(dot(b.az, axis));
    if (Math.abs(dot(d, axis)) > ra + rb - 1e-4) return false;
  }
  return true;
}

/** 점이 OBB 안에 있는지 */
export function obbContains(o: Obb, x: number, z: number): boolean {
  const dx = x - o.cx;
  const dz = z - o.cz;
  return Math.abs(dx * o.ax[0] + dz * o.ax[1]) <= o.hx && Math.abs(dx * o.az[0] + dz * o.az[1]) <= o.hz;
}

/** 파티션 선분에서 벽이 있는 구간(개구부 제외)만 반환 */
export function partitionSolidSpans(p: PartitionSegment): { a: Vec2; b: Vec2 }[] {
  const len = Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]);
  const dir: Vec2 = [(p.b[0] - p.a[0]) / len, (p.b[1] - p.a[1]) / len];
  const cuts = p.openings.map((o) => [o.offset - o.width / 2, o.offset + o.width / 2] as Vec2).sort((x, y) => x[0] - y[0]);
  const spans: Vec2[] = [];
  let s = 0;
  for (const [c0, c1] of cuts) {
    if (c0 > s) spans.push([s, c0]);
    s = Math.max(s, c1);
  }
  if (s < len) spans.push([s, len]);
  return spans.map(([t0, t1]) => ({
    a: [p.a[0] + dir[0] * t0, p.a[1] + dir[1] * t0],
    b: [p.a[0] + dir[0] * t1, p.a[1] + dir[1] * t1],
  }));
}
