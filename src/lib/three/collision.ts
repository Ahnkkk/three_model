import type { FurnitureItem, FurnitureKind, SceneConfig, Vec2 } from "@/config/sceneTypes";
import { footprintObb, hDeskLayout, partitionSolidSpans, segmentObb, type Obb } from "./layoutGeometry";
import { doorLeafSegment, partitionPlanFrame, wallPlanFrame } from "./planGeometry";

/**
 * 키보드 보행 충돌(바닥 평면 xz).
 *
 * 카메라를 반지름 r인 원(사람 몸통)으로 보고, 가구 footprint·파티션 벽 구간(개구부 제외)·열린 문짝을 장애물로 둔다.
 * 장면 데이터(가구 목록·파티션·개구부)에서 만들므로 2D 배치도·3D·배치 검증과 같은 위치를 쓴다.
 * three.js에 의존하지 않는 순수 함수로 두어 브라우저 없이 검증할 수 있게 한다(scripts/verify-office.ts).
 * 문짝이 통로를 막지 않는지는 검증 스크립트의 "입구에서 모든 공간 도달" 검사가 확인한다.
 *
 * 높이 판정: 장애물의 세로 범위 [y0, y1]가 발 + 턱(STEP_HEIGHT)보다 높고 눈높이(카메라 y)보다 아래에서 시작하면 막는다.
 * → 러그는 밟고 지나가고, 펜던트 조명은 머리 위에 있을 때만 통과한다.
 * 점프(stepWalker): 발이 올라가면 낮은 사물은 막지 않으므로 위로 넘어가거나 윗면(supportHeight)에 올라설 수 있다.
 */

export type Collider = { id: string; y0: number; y1: number } & ({ shape: "box"; box: Obb } | { shape: "circle"; cx: number; cz: number; r: number });

/** 발로 넘을 수 있는 높이(m) */
const STEP_HEIGHT = 0.1;
/** 한 번에 움직이는 최대 거리(m). 얇은 유리 파티션을 건너뛰지 않도록 이동을 나눈다. */
const MAX_SUBSTEP = 0.05;
/**
 * 이 깊이보다 깊게 겹친 상태로 시작했을 때만 "원래 겹쳐 있던 것"으로 인정한다(예: 소파 바로 앞 시점).
 * 그보다 얕은 겹침(밀어내기 수렴 오차)은 바로 밀어내서 걸음마다 조금씩 쌓이지 않게 한다.
 */
const START_OVERLAP_SLOP = 0.02;
/** 문짝 충돌 두께(m) */
const DOOR_LEAF_THICKNESS = 0.05;
/**
 * 사물 위에 딛고 서는 판정 반지름(m, 발 중심 기준). 몸통 반지름보다 작게 두어, 가장자리에서 몸 중심이 벗어나면
 * 바로 떨어진다(몸통 끝이 걸친 채 공중에 떠 있거나, 옆 사물로 건너가며 높이가 유지되지 않게).
 */
export const FOOT_RADIUS = 0.08;

/** 벽에 붙은 장식·바닥 마감은 장애물로 보지 않는다(벽은 카메라 위치 범위가 따로 막는다). */
const IGNORED_KINDS = new Set<FurnitureKind>(["rug", "wallArt"]);
const ROUND_KINDS = new Set<FurnitureKind>(["roundMeetingTable", "sideTable"]);

/** 가구 로컬 사각형(중심 x,z·크기 w,d)을 가구의 위치·회전으로 월드 OBB로 바꾼다. */
function localBox(item: FurnitureItem, x: number, z: number, w: number, d: number): Obb {
  const base = footprintObb(item);
  return {
    cx: base.cx + base.ax[0] * x + base.az[0] * z,
    cz: base.cz + base.ax[1] * x + base.az[1] * z,
    hx: w / 2,
    hz: d / 2,
    ax: base.ax,
    az: base.az,
  };
}

function furnitureColliders(item: FurnitureItem): Collider[] {
  if (IGNORED_KINDS.has(item.kind)) return [];
  const y0 = item.position[1];
  const y1 = y0 + item.size[1];
  if (ROUND_KINDS.has(item.kind)) return [{ id: item.id, y0, y1, shape: "circle", cx: item.position[0], cz: item.position[2], r: item.size[0] / 2 }];
  if (item.kind === "hDesk") {
    // H형은 두 평행 데스크 + 중앙 수납부만 막고, 좌석이 놓인 안쪽 공간은 비워 둔다.
    const L = hDeskLayout(item.size);
    const d = item.size[2];
    return [
      ...L.desks.map((dk, i) => ({ id: `${item.id}:desk${i}`, y0, y1, shape: "box" as const, box: localBox(item, dk.x, 0, L.deskWidth, d) })),
      { id: `${item.id}:spine`, y0, y1, shape: "box", box: localBox(item, 0, 0, L.spine.width, L.spine.depth) },
    ];
  }
  return [{ id: item.id, y0, y1, shape: "box", box: footprintObb(item) }];
}

/** 장면의 보행 장애물(가구·파티션 벽 구간·파티션 문짝·외벽 문짝·기둥). 외벽은 카메라 위치 범위(positionBounds)가 막는다. */
export function buildColliders(scene: Pick<SceneConfig, "furniture" | "partitions" | "room" | "columns">): Collider[] {
  const { room } = scene;
  const out: Collider[] = scene.furniture.flatMap(furnitureColliders);
  for (const c of scene.columns ?? []) {
    out.push({ id: c.id, y0: 0, y1: room.height, shape: "box", box: { cx: c.center[0], cz: c.center[1], hx: c.size[0] / 2, hz: c.size[1] / 2, ax: [1, 0], az: [0, 1] } });
  }
  const leaf = (id: string, ends: [Vec2, Vec2], y0: number, y1: number): Collider => ({
    id: `${id}:leaf`,
    y0,
    y1,
    shape: "box",
    box: segmentObb(ends[0], ends[1], DOOR_LEAF_THICKNESS),
  });
  for (const p of scene.partitions) {
    const height = p.height ?? room.height;
    partitionSolidSpans(p).forEach((span, i) => {
      out.push({ id: `${p.id}:span${i}`, y0: 0, y1: height, shape: "box", box: segmentObb(span.a, span.b, p.thickness) });
    });
    const f = partitionPlanFrame(p);
    for (const o of p.openings) {
      if (o.door && o.door.leaf !== "none") out.push(leaf(o.id, doorLeafSegment(f, o.offset - o.width / 2, o.width, o.door), 0, o.height));
    }
  }
  for (const o of room.openings) {
    if (o.kind !== "door" || !o.door || o.door.leaf === "none") continue;
    // 외벽 문짝은 벽 두께 가운데에 달린다(OfficeShell 출입문과 같은 위치).
    const ends = doorLeafSegment(wallPlanFrame(o.wall, room), o.center - o.width / 2, o.width, o.door, -room.wallThickness / 2);
    out.push(leaf(o.id, ends, o.bottom, o.bottom + o.height));
  }
  return out;
}

/**
 * 몸통(발 feetY ~ 눈 eyeHeight)을 옆에서 막는 장애물만 고른다.
 * 윗면이 발보다 턱 높이 이상 높아야 막고(그 이하는 딛고 올라선다), 아랫면이 눈보다 낮아야 막는다(머리 위 물건은 통과).
 */
export function activeColliders(colliders: Collider[], eyeHeight: number, feetY = 0): Collider[] {
  return colliders.filter((c) => c.y1 > feetY + STEP_HEIGHT && c.y0 < eyeHeight);
}

/**
 * (x, z)에 선 발(반지름 r — 보통 FOOT_RADIUS)이 딛을 수 있는 가장 높은 면의 높이(바닥 = 0).
 * 발과 겹치고 윗면이 발 + 턱 높이 이하인 물체만 딛는다. 가장자리에서 발이 벗어나면 떨어지며,
 * 떨어진 뒤 몸통이 그 물체와 조금 겹친 상태는 moveCircle이 허용한다(더 파고들지만 않게, 멀어지는 쪽으로는 자유).
 */
export function supportHeight(colliders: Collider[], x: number, z: number, radius: number, feetY: number): number {
  let ground = 0;
  for (const c of colliders) {
    if (c.y1 <= ground || c.y1 > feetY + STEP_HEIGHT + 1e-6) continue;
    if (penetration(c, x, z, radius).depth > 1e-4) ground = c.y1;
  }
  return ground;
}

/** 보행 상태: 위치(x, z), 발 높이(feet), 세로 속도(vy), 발에서 눈(카메라)까지 높이(eye) */
export interface WalkerState {
  x: number;
  z: number;
  feet: number;
  vy: number;
  eye: number;
}

export interface WalkerConfig {
  radius: number;
  jumpHeight: number;
  gravity: number;
  /** 수평 이동 범위(카메라 위치 범위의 xz) */
  bounds: { min: Vec2; max: Vec2 };
  /** 눈(카메라)이 올라갈 수 있는 최고 높이(천장 아래) */
  eyeMax: number;
}

/**
 * 보행 한 프레임: 수평 이동(충돌) → 딛는 면 계산 → 점프·중력·착지 → 천장.
 * - 점프해서 발이 사물 윗면 - 턱 높이보다 올라가면 그 사물은 더 이상 막지 않아 위로 지나가거나 올라설 수 있다.
 * - 내려오다 딛을 면을 만나면 그 높이에 착지하고, 발(몸 중심)이 가장자리를 벗어나면 중력으로 떨어진다.
 *   눈높이(eye)는 바꾸지 않으므로 바닥에 내려오면 올라가기 전 카메라 높이로 돌아온다.
 * - 오르는 중에 발이 어떤 면 바로 아래(턱 높이 이내)에 걸치면 그 면으로 올라선다(가장자리 붙잡고 오르기).
 */
export function stepWalker(
  colliders: Collider[],
  s: WalkerState,
  input: { dx: number; dz: number; jump: boolean },
  dt: number,
  cfg: WalkerConfig,
): WalkerState {
  let { x, z, feet, vy } = s;
  if (input.dx || input.dz) {
    [x, z] = moveCircle(activeColliders(colliders, feet + s.eye, feet), [x, z], [input.dx, input.dz], cfg.radius, cfg.bounds);
  }
  const ground = supportHeight(colliders, x, z, Math.min(cfg.radius, FOOT_RADIUS), feet);
  const grounded = vy === 0 && feet <= ground + 1e-4;
  if (input.jump && grounded) vy = Math.sqrt(2 * cfg.gravity * cfg.jumpHeight);

  if (vy !== 0 || feet > ground + 1e-4) {
    // 공중: 중력 적용, 딛을 면 아래로 내려가면 착지
    vy -= cfg.gravity * dt;
    feet += vy * dt;
    if (feet <= ground) {
      feet = ground;
      if (vy < 0) vy = 0;
    }
  } else if (ground > feet) {
    feet = ground; // 턱 높이 이하 면에 올라섬
  }

  // 천장: 눈이 eyeMax를 넘지 않게(이미 넘어 있으면 더 오르지만 않게) 하고 위로 가던 속도는 멈춘다.
  const feetMax = Math.max(s.feet, cfg.eyeMax - s.eye);
  if (feet > feetMax) {
    feet = feetMax;
    if (vy > 0) vy = 0;
  }
  return { x, z, feet, vy, eye: s.eye };
}

/** 원(중심 x,z, 반지름 r)을 장애물 밖으로 밀어낼 방향(nx,nz)과 깊이. 겹치지 않으면 depth ≤ 0 */
export function penetration(c: Collider, x: number, z: number, r: number): { nx: number; nz: number; depth: number } {
  if (c.shape === "circle") {
    const dx = x - c.cx;
    const dz = z - c.cz;
    const d = Math.hypot(dx, dz);
    if (d < 1e-9) return { nx: 1, nz: 0, depth: r + c.r };
    return { nx: dx / d, nz: dz / d, depth: r + c.r - d };
  }
  const o = c.box;
  const dx = x - o.cx;
  const dz = z - o.cz;
  const lx = dx * o.ax[0] + dz * o.ax[1];
  const lz = dx * o.az[0] + dz * o.az[1];
  const qx = Math.max(-o.hx, Math.min(o.hx, lx));
  const qz = Math.max(-o.hz, Math.min(o.hz, lz));
  let nlx: number;
  let nlz: number;
  let depth: number;
  if (qx !== lx || qz !== lz) {
    // 바깥: 가장 가까운 점에서 바깥쪽으로
    const ex = lx - qx;
    const ez = lz - qz;
    const d = Math.hypot(ex, ez);
    nlx = ex / d;
    nlz = ez / d;
    depth = r - d;
  } else {
    // 안쪽: 덜 들어간 축으로 빠져나간다
    const px = o.hx - Math.abs(lx);
    const pz = o.hz - Math.abs(lz);
    if (px < pz) {
      nlx = lx < 0 ? -1 : 1;
      nlz = 0;
      depth = px + r;
    } else {
      nlx = 0;
      nlz = lz < 0 ? -1 : 1;
      depth = pz + r;
    }
  }
  return { nx: nlx * o.ax[0] + nlz * o.az[0], nz: nlx * o.ax[1] + nlz * o.az[1], depth };
}

/**
 * 원을 from에서 delta만큼 옮기되 장애물을 뚫지 않게 한다(벽을 따라 미끄러짐).
 * 이미 겹친 상태에서 시작하면(예: 소파 바로 앞 시점) 그보다 더 깊이 들어가는 움직임만 막는다.
 * → 시점 전환 직후 카메라가 튀지 않고, 장애물에서 멀어지는 방향으로는 자연스럽게 빠져나온다.
 */
export function moveCircle(
  colliders: Collider[],
  from: Vec2,
  delta: Vec2,
  radius: number,
  bounds?: { min: Vec2; max: Vec2 },
): Vec2 {
  const steps = Math.max(1, Math.ceil(Math.hypot(delta[0], delta[1]) / MAX_SUBSTEP));
  let [x, z] = from;
  for (let s = 0; s < steps; s++) {
    const allowed = colliders.map((c) => {
      const d = penetration(c, x, z, radius).depth;
      return d > START_OVERLAP_SLOP ? d : 0;
    });
    const clampToBounds = (px: number, pz: number): Vec2 =>
      bounds ? [Math.max(bounds.min[0], Math.min(bounds.max[0], px)), Math.max(bounds.min[1], Math.min(bounds.max[1], pz))] : [px, pz];
    // 경계 보정을 먼저 한 뒤 밀어낸다(보정이 마지막이면 가구 안으로 되돌아갈 수 있다).
    let [nx, nz] = clampToBounds(x + delta[0] / steps, z + delta[1] / steps);
    for (let iter = 0; iter < 6; iter++) {
      let pushed = false;
      colliders.forEach((c, i) => {
        const p = penetration(c, nx, nz, radius);
        const excess = p.depth - allowed[i];
        if (excess > 1e-6) {
          nx += p.nx * excess;
          nz += p.nz * excess;
          pushed = true;
        }
      });
      if (!pushed) break;
      [nx, nz] = clampToBounds(nx, nz);
    }
    // 몸통보다 좁은 틈·경계와 가구 사이 등에서 밀어내기가 수렴하지 않으면 이 걸음은 취소한다(조금씩 파고드는 것 방지).
    if (colliders.some((c, i) => penetration(c, nx, nz, radius).depth - allowed[i] > 1e-3)) break;
    x = nx;
    z = nz;
  }
  return [x, z];
}

/**
 * p에서 가장 가까운 "몸통이 들어갈 수 있는" 위치(미니맵 클릭 이동용).
 * p가 비어 있으면 그대로, 가구·벽 위라면 p를 중심으로 반경을 5cm씩 넓히며 처음 찾은 빈자리를 돌려준다.
 * maxRadius 안에 빈자리가 없으면 null.
 */
export function nearestFreeSpot(
  colliders: Collider[],
  p: Vec2,
  radius: number,
  bounds?: { min: Vec2; max: Vec2 },
  maxRadius = 3,
): Vec2 | null {
  const clampToBounds = (x: number, z: number): Vec2 =>
    bounds ? [Math.max(bounds.min[0], Math.min(bounds.max[0], x)), Math.max(bounds.min[1], Math.min(bounds.max[1], z))] : [x, z];
  const free = (q: Vec2) => colliders.every((c) => penetration(c, q[0], q[1], radius).depth <= 0);
  const start = clampToBounds(p[0], p[1]);
  if (free(start)) return start;
  for (let r = 0.05; r <= maxRadius + 1e-9; r += 0.05) {
    const n = Math.max(12, Math.ceil((2 * Math.PI * r) / 0.05));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const q = clampToBounds(start[0] + Math.cos(a) * r, start[1] + Math.sin(a) * r);
      if (free(q)) return q;
    }
  }
  return null;
}
