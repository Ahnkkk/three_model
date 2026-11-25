import type { SceneConfig, Vec2 } from "@/config/sceneTypes";
import { footprintObb, obbContains, obbOverlap, partitionSolidSpans, rectObb, segmentObb, type Obb } from "./layoutGeometry";
import { partitionPlanFrame, planPoint, wallPlanFrame, type PlanFrame } from "./planGeometry";

/**
 * 일반 배치 검증(비브라우저): 어떤 장면에도 적용하는 형상·동선 검사.
 * - 방 경계, 가구 겹침(의자↔테이블 제외), 파티션·기둥 관통, 문 열림 영역(내부·외벽 문), 출입문에서 각 영역까지의 동선
 * 장면 전용 수량 검사(예: 사무실 좌석 수)는 호출하는 쪽(officeLayout.validateOfficeLayout)이 더한다.
 * 반환값이 비어 있으면 통과.
 */

const TABLE_KINDS = new Set(["conferenceTable", "roundMeetingTable", "hDesk", "sideTable", "coffeeTable"]);
const CHAIR_KINDS = new Set(["meetingChair", "officeChair"]);
/** 바닥 마감·벽 장식은 배치 검사에서 제외 */
const FLAT_KINDS = new Set(["rug", "wallArt"]);

export function validateSceneLayout(scene: SceneConfig): string[] {
  const issues: string[] = [];
  const items = scene.furniture.filter((it) => !FLAT_KINDS.has(it.kind));
  const label = (it: { label: string; id: string }) => it.label || it.id;

  // 방 경계
  const hw = scene.room.width / 2;
  const hd = scene.room.depth / 2;
  for (const it of items) {
    const o = footprintObb(it);
    const outside = [-1, 1].some((sx) =>
      [-1, 1].some((sz) => {
        const x = o.cx + sx * o.hx * o.ax[0] + sz * o.hz * o.az[0];
        const z = o.cz + sx * o.hx * o.ax[1] + sz * o.hz * o.az[1];
        return Math.abs(x) > hw + 1e-3 || Math.abs(z) > hd + 1e-3;
      }),
    );
    if (outside) issues.push(`${label(it)}: 방 경계를 벗어남`);
  }

  // 가구 겹침(의자는 테이블 아래로 일부 들어가는 것을 허용)
  const obbs = items.map((it) => ({ it, o: footprintObb(it, CHAIR_KINDS.has(it.kind) ? 0.04 : 0.01) }));
  for (let i = 0; i < obbs.length; i++) {
    for (let j = i + 1; j < obbs.length; j++) {
      const A = obbs[i];
      const B = obbs[j];
      const chairTable =
        (CHAIR_KINDS.has(A.it.kind) && TABLE_KINDS.has(B.it.kind)) || (CHAIR_KINDS.has(B.it.kind) && TABLE_KINDS.has(A.it.kind));
      if (chairTable) continue;
      if (obbOverlap(A.o, B.o)) issues.push(`겹침: ${label(A.it)} ↔ ${label(B.it)}`);
    }
  }

  // 파티션·기둥 관통
  for (const p of scene.partitions) {
    for (const span of partitionSolidSpans(p)) {
      const so = segmentObb(span.a, span.b, p.thickness);
      for (const { it, o } of obbs) if (obbOverlap(so, o)) issues.push(`파티션 관통: ${p.id} ↔ ${label(it)}`);
    }
  }
  for (const c of scene.columns ?? []) {
    const co = columnObb(c.center, c.size);
    for (const { it, o } of obbs) if (obbOverlap(co, o)) issues.push(`기둥 관통: ${c.id} ↔ ${label(it)}`);
  }

  // 문 열림 영역(경첩을 중심으로 문 폭 반지름의 부채꼴)에 가구가 없는지
  const doors: { id: string; frame: PlanFrame; x0: number; width: number; hinge: "start" | "end"; swing: "pos" | "neg" }[] = [];
  for (const p of scene.partitions) {
    const f = partitionPlanFrame(p);
    for (const o of p.openings) {
      if (!o.door || o.door.leaf === "none" || o.door.angle <= 0) continue;
      doors.push({ id: o.id, frame: f, x0: o.offset - o.width / 2, width: o.width, hinge: o.door.hinge, swing: o.door.swing });
    }
  }
  for (const o of scene.room.openings) {
    if (o.kind !== "door" || !o.door || o.door.leaf === "none" || o.door.angle <= 0) continue;
    doors.push({ id: o.id, frame: wallPlanFrame(o.wall, scene.room), x0: o.center - o.width / 2, width: o.width, hinge: o.door.hinge, swing: o.door.swing });
  }
  for (const d of doors) {
    const hinge = planPoint(d.frame, d.hinge === "start" ? d.x0 : d.x0 + d.width);
    const side = d.swing === "pos" ? 1 : -1;
    for (const { it } of obbs) {
      const dx = it.position[0] - hinge[0];
      const dz = it.position[2] - hinge[1];
      const ahead = (dx * d.frame.n[0] + dz * d.frame.n[1]) * side > 0;
      if (ahead && Math.hypot(dx, dz) < d.width + Math.min(it.size[0], it.size[2]) / 2 - 0.05) issues.push(`문 열림 간섭: ${d.id} ↔ ${label(it)}`);
    }
  }

  // 출입문에서 각 영역까지 동선(0.1m 격자, 벽·파티션·기둥만 장애물로 보고 문은 열린 것으로 간주)
  issues.push(...checkReachability(scene));
  return issues;
}

function columnObb(center: Vec2, size: Vec2): Obb {
  return rectObb(center[0] - size[0] / 2, center[1] - size[1] / 2, center[0] + size[0] / 2, center[1] + size[1] / 2);
}

/** 외벽 문(출입문) 안쪽에서 출발해 각 영역 중심에 도달할 수 있는지 */
function checkReachability(scene: SceneConfig): string[] {
  const cell = 0.1;
  const W = scene.room.width;
  const D = scene.room.depth;
  const nx = Math.round(W / cell);
  const nz = Math.round(D / cell);
  const blocked = new Uint8Array(nx * nz);
  const clearance = 0.25; // 사람 통과 여유(반경)
  const obstacles: Obb[] = [
    ...scene.partitions.flatMap((p) => partitionSolidSpans(p).map((s) => segmentObb(s.a, s.b, p.thickness + clearance * 2))),
    ...(scene.columns ?? []).map((c) => columnObb(c.center, [c.size[0] + clearance * 2, c.size[1] + clearance * 2])),
  ];
  for (const o of obstacles) {
    for (let i = 0; i < nx; i++)
      for (let k = 0; k < nz; k++) {
        if (obbContains(o, -W / 2 + (i + 0.5) * cell, -D / 2 + (k + 0.5) * cell)) blocked[k * nx + i] = 1;
      }
  }
  const idx = (x: number, z: number) => {
    const i = Math.min(nx - 1, Math.max(0, Math.floor((x + W / 2) / cell)));
    const k = Math.min(nz - 1, Math.max(0, Math.floor((z + D / 2) / cell)));
    return k * nx + i;
  };
  const entrances = scene.room.openings.filter((o) => o.kind === "door");
  if (!entrances.length) return ["출입문(외벽 문)이 없어 동선을 검사할 수 없습니다."];
  const seen = new Uint8Array(nx * nz);
  const queue: number[] = [];
  for (const e of entrances) {
    const [x, z] = planPoint(wallPlanFrame(e.wall, scene.room), e.center, 0.3);
    const start = idx(x, z);
    if (!seen[start]) {
      seen[start] = 1;
      queue.push(start);
    }
  }
  while (queue.length) {
    const c = queue.pop()!;
    const i = c % nx;
    const k = (c - i) / nx;
    for (const [di, dk] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const ni = i + di;
      const nk = k + dk;
      if (ni < 0 || nk < 0 || ni >= nx || nk >= nz) continue;
      const n = nk * nx + ni;
      if (seen[n] || blocked[n]) continue;
      seen[n] = 1;
      queue.push(n);
    }
  }
  const issues: string[] = [];
  for (const z of scene.plan?.zones ?? []) {
    const cx = (z.rect[0] + z.rect[2]) / 2;
    const cz = (z.rect[1] + z.rect[3]) / 2;
    if (!seen[idx(cx, cz)]) issues.push(`동선 단절: 입구에서 ${z.label}에 도달할 수 없음`);
  }
  return issues;
}
