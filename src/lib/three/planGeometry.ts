import type { DoorSpec, PartitionSegment, RoomConfig, Vec2, WallId } from "@/config/sceneTypes";

/**
 * 평면(xz) 기하 공용 함수: 외벽·파티션의 로컬 좌표계와 열린 문짝 선분.
 * 보행 충돌(collision.ts)과 미니맵이 함께 쓰며, three.js에 의존하지 않는다.
 */

/** 2D 좌표계: 원점 + 벽 방향(u) + 실내 방향(n), 월드 [x, z] */
export interface PlanFrame {
  origin: Vec2;
  u: Vec2;
  n: Vec2;
}

/**
 * 외벽 안쪽 면의 로컬 좌표계(roomSurfaces.getSurfaceFrames와 같은 규칙).
 * 개구부 center는 이 u축을 따라 잰 거리다(실내에서 바라본 벽의 왼쪽 끝 = 0).
 */
export function wallPlanFrame(wall: WallId, room: Pick<RoomConfig, "width" | "depth">): PlanFrame {
  const W = room.width / 2;
  const D = room.depth / 2;
  switch (wall) {
    case "north":
      return { origin: [-W, -D], u: [1, 0], n: [0, 1] };
    case "south":
      return { origin: [W, D], u: [-1, 0], n: [0, -1] };
    case "west":
      return { origin: [-W, D], u: [0, -1], n: [1, 0] };
    case "east":
      return { origin: [W, -D], u: [0, 1], n: [-1, 0] };
  }
}

/** 파티션 선분의 로컬 좌표계(u = a→b, n = 3D 파티션 로컬 +z = swing "pos" 방향) */
export function partitionPlanFrame(p: Pick<PartitionSegment, "a" | "b">): PlanFrame {
  const len = Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]);
  const u: Vec2 = [(p.b[0] - p.a[0]) / len, (p.b[1] - p.a[1]) / len];
  return { origin: p.a, u, n: [-u[1], u[0]] };
}

export const planPoint = (f: PlanFrame, s: number, t = 0): Vec2 => [f.origin[0] + f.u[0] * s + f.n[0] * t, f.origin[1] + f.u[1] * s + f.n[1] * t];

/**
 * 열린 문짝 선분 [경첩, 문 끝]. PartitionSystem.DoorLeaf·FloorPlanSvg와 같은 규칙:
 * 경첩은 start면 개구부 시작(x0), end면 끝(x0 + width)이고, swing 쪽(pos = +n, neg = -n)으로 angle만큼 열린다.
 * offsetN: 문짝이 달린 면에서 n 방향 거리(외벽은 벽 두께 가운데 = -두께/2).
 */
export function doorLeafSegment(f: PlanFrame, x0: number, width: number, spec: DoorSpec, offsetN = 0): [Vec2, Vec2] {
  const start = spec.hinge === "start";
  const dir = start ? 1 : -1;
  const side = spec.swing === "pos" ? 1 : -1;
  const a = (spec.angle * Math.PI) / 180;
  const hinge = planPoint(f, start ? x0 : x0 + width, offsetN);
  const tx = f.u[0] * dir * Math.cos(a) + f.n[0] * side * Math.sin(a);
  const tz = f.u[1] * dir * Math.cos(a) + f.n[1] * side * Math.sin(a);
  return [hinge, [hinge[0] + tx * width, hinge[1] + tz * width]];
}
