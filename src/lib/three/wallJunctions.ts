import type { PartitionSegment, Vec2 } from "@/config/sceneTypes";

/**
 * 내부 벽 접합 처리(중심선 → 표시·충돌용 선분).
 *
 * 벽은 중심선으로 들어오므로 그대로 그리면 접합부에 틈(L자 바깥 모서리)이나 겹친 면(T자 줄기가 다른 벽 두께 안으로
 * 들어감)이 생긴다. 끝점을 다음 규칙으로 늘리거나 줄여 2D·3D·충돌이 같은 결과를 쓰게 한다.
 * - T자: 끝점이 다른 벽의 몸체(또는 일직선으로 이어지는 두 벽의 연결점)에 닿으면 그 벽 두께의 절반만큼 줄인다.
 * - L자: 두 벽의 끝점이 만나면 목록 앞쪽 벽을 상대 두께 절반만큼 늘리고, 뒤쪽 벽을 이쪽 두께 절반만큼 줄인다.
 * - 일직선 연결(끝점끼리, 같은 방향)·외곽 면에 닿는 끝점·X자 교차는 바꾸지 않는다.
 * 기울어진 접합은 두께 절반 / sin(사잇각)으로 보정한다(사잇각이 매우 작으면 제한).
 * 개구부 offset은 선분 시작점 이동만큼 보정해 월드 위치를 유지한다.
 */

const TOL = 0.001;
const PARALLEL_SIN = 1e-3;
/** 사잇각 보정 상한(sin 최소값) */
const MIN_SIN = 0.3;

interface Seg {
  a: Vec2;
  b: Vec2;
  dir: Vec2;
  len: number;
  thickness: number;
}

const near = (p: Vec2, q: Vec2) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= TOL;
const cross = (p: Vec2, q: Vec2) => p[0] * q[1] - p[1] * q[0];

/** p가 선분 s의 몸체(양 끝점 제외) 위에 있는지 */
function onBody(p: Vec2, s: Seg): boolean {
  const t = (p[0] - s.a[0]) * s.dir[0] + (p[1] - s.a[1]) * s.dir[1];
  if (t <= TOL || t >= s.len - TOL) return false;
  return Math.abs(cross(s.dir, [p[0] - s.a[0], p[1] - s.a[1]])) <= TOL;
}

const isEnd = (p: Vec2, s: Seg) => near(p, s.a) || near(p, s.b);
const parallel = (s: Seg, o: Seg) => Math.abs(cross(s.dir, o.dir)) < PARALLEL_SIN;

/** 끝점 p에서 벽 i를 얼마나 줄일지(양수 = 줄임, 음수 = 늘림) */
function endAdjust(i: number, p: Vec2, segs: Seg[]): number {
  const me = segs[i];
  // p를 끝점으로 가지면서 일직선으로 이어지는 벽이 있으면 그 벽의 선은 p를 통과한다.
  const continues = (j: number) => segs.some((k, kk) => kk !== j && isEnd(p, k) && isEnd(p, segs[j]) && parallel(k, segs[j]));
  let trim = 0;
  let lPartner = -1;
  segs.forEach((o, j) => {
    if (j === i || parallel(me, o)) return;
    const sin = Math.max(MIN_SIN, Math.abs(cross(me.dir, o.dir)));
    if (onBody(p, o) || (isEnd(p, o) && continues(j))) {
      trim = Math.max(trim, o.thickness / 2 / sin); // T자
    } else if (isEnd(p, o) && lPartner < 0) {
      lPartner = j;
    }
  });
  if (trim > 0) return trim;
  if (lPartner < 0 || continues(i)) return 0; // 접합 없음, 또는 이 벽이 일직선으로 이어져 상대가 T자로 줄어듦
  const o = segs[lPartner];
  const amount = o.thickness / 2 / Math.max(MIN_SIN, Math.abs(cross(me.dir, o.dir)));
  return i < lPartner ? -amount : amount; // L자: 앞쪽 벽이 모서리를 덮는다
}

const round = (n: number) => Math.round(n * 1e6) / 1e6 + 0;

export function resolveWallJunctions(partitions: PartitionSegment[]): PartitionSegment[] {
  const segs: Seg[] = partitions.map((p) => {
    const len = Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]);
    return { a: p.a, b: p.b, dir: [(p.b[0] - p.a[0]) / len, (p.b[1] - p.a[1]) / len], len, thickness: p.thickness };
  });
  return partitions.map((p, i) => {
    const s = segs[i];
    const trimA = endAdjust(i, s.a, segs);
    const trimB = endAdjust(i, s.b, segs);
    if (trimA === 0 && trimB === 0) return p;
    return {
      ...p,
      a: [round(s.a[0] + s.dir[0] * trimA), round(s.a[1] + s.dir[1] * trimA)],
      b: [round(s.b[0] - s.dir[0] * trimB), round(s.b[1] - s.dir[1] * trimB)],
      openings: p.openings.map((o) => ({ ...o, offset: round(o.offset - trimA) })),
    };
  });
}
