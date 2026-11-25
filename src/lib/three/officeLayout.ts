import { OFFICE_PLAN, type PlanZone } from "@/config/officePlan";
import type {
  FurnitureItem,
  LampLight,
  PartitionSegment,
  PlanCallout,
  PlanView,
  SceneAnnotation,
  SceneColumn,
  SceneConfig,
  Vec2,
  Vec3,
  WallOpening,
} from "@/config/sceneTypes";
import { hDeskLayout } from "./layoutGeometry";
import { validateSceneLayout } from "./layoutValidation";

/**
 * 사무실 도면 데이터(officePlan.ts) → 3D·2D 공용 데이터.
 *
 * 이 파일의 결과(가구 목록·파티션·개구부·영역)를 3D 장면, 라이트맵 베이크, SVG 평면도가 함께 사용한다.
 * three.js에 의존하지 않는 순수 함수로 두어 브라우저 없이 검증할 수 있게 한다.
 * 장면 공용 기하(footprint·선분·H형 데스크)는 layoutGeometry.ts, 일반 배치 검증은 layoutValidation.ts에 있다.
 */

export { footprintObb, hDeskLayout, partitionSolidSpans, segmentObb, type HDeskLayout, type Obb } from "./layoutGeometry";

const P = OFFICE_PLAN;

/** 도면 (u, v) → 월드 (x, z) */
export const planToWorld = (u: number, v: number): Vec2 => [u - P.width / 2, v - P.depth / 2];
export const worldToPlan = (x: number, z: number): Vec2 => [x + P.width / 2, z + P.depth / 2];

export const CHAIR_SIZE: Record<"meetingChair" | "officeChair", Vec3> = {
  meetingChair: [0.52, 0.84, 0.54],
  officeChair: [0.64, 1.0, 0.64],
};

const CHAIR_BAKE = { strength: 0.3, radius: 0.12 };

/**
 * 좌표를 0.1mm 단위로 반올림한다. 삼각함수 결과의 마지막 자리가 실행 환경(Node 서버 렌더링 / 브라우저)마다
 * 달라 SVG 속성 값이 어긋나는(hydration 불일치) 것을 막고, 설정 데이터를 결정적으로 만든다.
 */
const q = (n: number) => Math.round(n * 1e4) / 1e4 + 0;

/* ------------------------------ 좌석 배열 ------------------------------ */

interface RectTableSpec {
  id: string;
  center: Vec2;
  width: number;
  length: number;
  perSide: number;
  ends: number;
  spacing: number;
  chairColor: string;
}

/** 긴 방향이 z(도면 v)인 직사각 테이블 주변 좌석 */
function rectTableChairs(t: RectTableSpec, zone: string, label: string): FurnitureItem[] {
  const [cx, cz] = planToWorld(...t.center);
  const offset = 0.3; // 테이블 가장자리에서 의자 중심까지
  const out: FurnitureItem[] = [];
  let n = 0;
  const push = (x: number, z: number, rotationY: number) =>
    out.push({
      id: `${t.id}-chair-${++n}`,
      kind: "meetingChair",
      label: `${label} 의자 ${n}`,
      position: [q(x), 0, q(z)],
      rotationY,
      size: CHAIR_SIZE.meetingChair,
      variant: { color: t.chairColor },
      bake: CHAIR_BAKE,
      group: t.id,
      zone,
    });
  for (const side of [-1, 1]) {
    for (let i = 0; i < t.perSide; i++) {
      const z = cz + (i - (t.perSide - 1) / 2) * t.spacing;
      push(cx + side * (t.width / 2 + offset), z, side < 0 ? 90 : -90);
    }
  }
  if (t.ends > 0) {
    push(cx, cz - (t.length / 2 + offset), 0);
    push(cx, cz + (t.length / 2 + offset), 180);
  }
  return out;
}

/* ------------------------------ 가구 목록 ------------------------------ */

export function buildOfficeFurniture(): FurnitureItem[] {
  const items: FurnitureItem[] = [];
  const at = (u: number, v: number, y = 0): Vec3 => {
    const [x, z] = planToWorld(u, v);
    return [q(x), y, q(z)];
  };

  // 대회의실: 테이블 + 14석 + 벤치 2 + 낮은 수납장
  const c = P.conference;
  items.push({
    id: c.id,
    kind: "conferenceTable",
    label: "대회의 테이블",
    position: at(...c.center),
    size: [c.width, 0.74, c.length],
    variant: { ports: c.ports },
    bake: { strength: 0.45, radius: 0.22 },
    group: c.id,
    zone: "large-meeting",
  });
  items.push(...rectTableChairs({ ...c, center: [...c.center] as Vec2 }, "large-meeting", "대회의실"));
  for (const b of P.benches) {
    items.push({
      id: b.id,
      kind: "bench",
      label: b.facing === "east" ? "벤치(서측)" : "벤치(동측)",
      position: at(...b.center),
      rotationY: b.facing === "east" ? 90 : -90,
      size: [b.length, P.bench.height, P.bench.depth],
      variant: { color: P.bench.color },
      bake: { strength: 0.5, radius: 0.16 },
      zone: "large-meeting",
    });
  }
  items.push({
    id: "credenza",
    kind: "lowCabinet",
    label: "낮은 수납장",
    position: at(...P.credenza.center),
    rotationY: 180,
    size: [...P.credenza.size],
    bake: { strength: 0.45, radius: 0.14 },
    zone: "large-meeting",
  });

  // 소회의실: 테이블 + 6석
  const s = P.smallMeeting;
  items.push({
    id: s.id,
    kind: "conferenceTable",
    label: "소회의 테이블",
    position: at(...s.center),
    size: [s.width, 0.74, s.length],
    variant: { ports: s.ports },
    bake: { strength: 0.45, radius: 0.2 },
    group: s.id,
    zone: "small-meeting",
  });
  items.push(...rectTableChairs({ ...s, center: [...s.center] as Vec2 }, "small-meeting", "소회의실"));

  // 업무공간: H형 2세트 + 업무 의자
  const hSize: Vec3 = [...P.hDeskSize];
  const layout = hDeskLayout(hSize);
  for (const h of P.hDesks) {
    const [hx, , hz] = at(...h.center);
    items.push({
      id: h.id,
      kind: "hDesk",
      label: h.label,
      position: [hx, 0, hz],
      size: hSize,
      bake: { strength: 0.45, radius: 0.2 },
      group: h.id,
      zone: "work-area",
    });
    layout.seats.forEach((seat, i) =>
      items.push({
        id: `${h.id}-chair-${i + 1}`,
        kind: "officeChair",
        label: `${h.label} 의자 ${i + 1}`,
        position: [q(hx + seat.x), 0, q(hz + seat.z)],
        rotationY: seat.rotationY,
        size: CHAIR_SIZE.officeChair,
        variant: { color: P.hDeskChairColor },
        bake: CHAIR_BAKE,
        group: h.id,
        zone: "work-area",
      }),
    );
  }

  // 오픈 미팅: 원형 테이블 2개 + 각 3석
  const rt = P.roundTable;
  for (const t of P.roundTables) {
    const [tx, , tz] = at(...t.center);
    items.push({
      id: t.id,
      kind: "roundMeetingTable",
      label: t.id === "round-1" ? "원형 테이블 ①" : "원형 테이블 ②",
      position: [tx, 0, tz],
      size: [rt.diameter, rt.height, rt.diameter],
      bake: { strength: 0.35, radius: 0.18 },
      group: t.id,
      zone: "open-meeting",
    });
    const r = rt.diameter / 2 + 0.32;
    for (let i = 0; i < rt.seats; i++) {
      const theta = (i * 360) / rt.seats; // 0 = 북쪽, 시계 방향
      const rad = (theta * Math.PI) / 180;
      items.push({
        id: `${t.id}-chair-${i + 1}`,
        kind: "meetingChair",
        label: `${t.id === "round-1" ? "원형 테이블 ①" : "원형 테이블 ②"} 의자 ${i + 1}`,
        position: [q(tx + Math.sin(rad) * r), 0, q(tz - Math.cos(rad) * r)],
        rotationY: -theta, // 테이블 중심을 바라봄
        size: CHAIR_SIZE.meetingChair,
        variant: { color: rt.chairColor },
        bake: CHAIR_BAKE,
        group: t.id,
        zone: "open-meeting",
      });
    }
  }

  // 휴게라운지: 기존 소파·암체어·원형 sideTable 재사용
  const l = P.lounge;
  items.push({
    id: "lounge-sofa",
    kind: "sofa",
    label: "라운지 소파",
    position: at(...l.sofa.center),
    size: [...l.sofa.size],
    variant: { color: l.sofa.color },
    bake: { strength: 0.55, radius: 0.2 },
    zone: "lounge",
  });
  items.push({
    id: "lounge-table",
    kind: "sideTable",
    label: "라운지 원형 테이블",
    position: at(...l.table.center),
    size: [...l.table.size],
    variant: { color: "#d39a52" },
    bake: { strength: 0.35, radius: 0.14 },
    zone: "lounge",
  });
  items.push({
    id: "lounge-armchair",
    kind: "armchair",
    label: "라운지 암체어",
    position: at(...l.armchair.center),
    rotationY: l.armchair.rotation,
    size: [...l.armchair.size],
    variant: { color: l.armchair.color },
    bake: { strength: 0.5, radius: 0.18 },
    zone: "lounge",
  });

  // 탕비: 상판·하부장·싱크·가전
  items.push({
    id: "pantry-counter",
    kind: "pantryCounter",
    label: "탕비 카운터",
    position: at(...P.pantry.center),
    size: [...P.pantry.size],
    bake: { strength: 0.5, radius: 0.16 },
    zone: "pantry",
  });

  return items;
}

/* ------------------------------ 벽·파티션·개구부 ------------------------------ */

export function buildOfficePartitions(): PartitionSegment[] {
  return P.partitions.map((p) => ({
    id: p.id,
    kind: p.kind,
    a: planToWorld(...p.a),
    b: planToWorld(...p.b),
    thickness: p.kind === "glass" ? 0.08 : 0.12,
    openings: (p.openings ?? []).map((o) => ({ id: o.id, offset: o.offset, width: o.width, height: o.height ?? 2.1, door: o.door })),
  }));
}

export function buildOfficeOpenings(): WallOpening[] {
  const w = P.windows;
  const windows: WallOpening[] = w.centers.map((v, i) => ({
    id: `west-window-${i + 1}`,
    wall: "west",
    kind: "window",
    center: P.depth - v, // 서쪽 벽 로컬 좌표: 남쪽 끝이 0
    bottom: w.bottom,
    width: w.width,
    height: w.height,
  }));
  const e = P.entrance;
  return [
    ...windows,
    {
      id: "entrance",
      wall: "south",
      kind: "door",
      center: P.width - e.u, // 남쪽 벽 로컬 좌표: 동쪽 끝이 0
      bottom: 0,
      width: e.width,
      height: e.height,
      door: e.door,
    },
  ];
}

export interface WorldZone extends Omit<PlanZone, "rect" | "labelAt"> {
  /** 월드 [x0, z0, x1, z1] */
  rect: [number, number, number, number];
  labelAt?: Vec2;
}

export function buildOfficeZones(): WorldZone[] {
  return P.zones.map((z) => {
    const [x0, z0] = planToWorld(z.rect[0], z.rect[1]);
    const [x1, z1] = planToWorld(z.rect[2], z.rect[3]);
    return { ...z, rect: [x0, z0, x1, z1], labelAt: z.labelAt ? planToWorld(...z.labelAt) : undefined };
  });
}

export function buildOfficeAnnotations(): SceneAnnotation[] {
  return P.annotations.map((a) => {
    const [x, z] = planToWorld(...a.at);
    return { id: a.id, label: a.label, position: [x, a.y, z], arrow: a.arrow };
  });
}

export function buildOfficeLamps(): LampLight[] {
  return P.ceilingLights.map(([u, v], i) => {
    const [x, z] = planToWorld(u, v);
    return { id: `ceiling-light-${i + 1}`, position: [x, P.height - 0.35, z], color: "#fff3e2", intensity: 5.5, castShadow: false };
  });
}

/** 서쪽 창 사이 실내 쪽 기둥(외벽 안쪽 면에 붙음) */
export function buildOfficeColumns(): SceneColumn[] {
  const { piers } = P;
  return piers.centers.map((v, i) => ({ id: `west-pier-${i + 1}`, center: planToWorld(piers.depth / 2, v), size: [piers.depth, piers.width] }));
}

/** 2D 평면도 표시 정보: 영역·표시 치수·H형 데스크와 입구 이름표 */
export function buildOfficePlanView(): PlanView {
  const zones = buildOfficeZones().map((z) => ({
    id: z.id,
    label: z.label,
    sub: z.sub,
    rect: z.rect,
    labelAt: z.labelAt,
    material: z.floor,
    assumption: z.assumption,
  }));
  const dimensions = P.dimensions.map((d) => {
    const horizontal = d.side === "top" || d.side === "bottom";
    const at = (n: number) => (horizontal ? planToWorld(n, 0)[0] : planToWorld(0, n)[1]);
    return { side: d.side, from: at(d.from), to: at(d.to), label: d.label, assumption: d.assumption };
  });
  const callouts: PlanCallout[] = P.hDesks.map((h) => {
    const [x, z] = planToWorld(...h.center);
    return { id: h.id, label: h.label, x, side: "top", tipZ: z - P.hDeskSize[2] / 2 + 0.45 };
  });
  const [entranceX] = planToWorld(P.entrance.u, P.depth);
  callouts.push({ id: "entrance", label: "입구", x: entranceX, side: "bottom", tipZ: P.depth / 2 + P.wallThickness + 0.05 });
  return { zones, dimensions, callouts };
}

/* ------------------------------ 요약·검증 ------------------------------ */

export interface OfficeSummary {
  largeMeetingSeats: number;
  smallMeetingSeats: number;
  hDeskSets: number;
  workSeats: number;
  roundTables: number;
  openMeetingSeats: number;
  totalChairs: number;
}

export function summarizeOffice(items: FurnitureItem[]): OfficeSummary {
  const chairs = items.filter((i) => i.kind === "meetingChair" || i.kind === "officeChair");
  const inZone = (zone: string) => chairs.filter((c) => c.zone === zone).length;
  return {
    largeMeetingSeats: inZone("large-meeting"),
    smallMeetingSeats: inZone("small-meeting"),
    hDeskSets: items.filter((i) => i.kind === "hDesk").length,
    workSeats: inZone("work-area"),
    roundTables: items.filter((i) => i.kind === "roundMeetingTable").length,
    openMeetingSeats: inZone("open-meeting"),
    totalChairs: chairs.length,
  };
}

/**
 * 사무실 배치 검증: 사무실 전용 수량(좌석·데스크·테이블) + 일반 배치 검증(layoutValidation.ts —
 * 방 경계, 가구 겹침, 파티션 관통, 문 열림 영역, 출입문에서 각 공간까지의 동선). 반환값이 비어 있으면 통과.
 */
export function validateOfficeLayout(scene: SceneConfig): string[] {
  const issues: string[] = [];
  const sum = summarizeOffice(scene.furniture);
  const expect = (name: string, actual: number, wanted: number) => {
    if (actual !== wanted) issues.push(`${name}: ${actual} (기대값 ${wanted})`);
  };
  expect("대회의실 좌석", sum.largeMeetingSeats, 14);
  expect("소회의실 좌석", sum.smallMeetingSeats, 6);
  expect("H형 데스크", sum.hDeskSets, 2);
  expect("원형 미팅 테이블", sum.roundTables, 2);
  expect("업무 좌석(가정)", sum.workSeats, P.hDesks.length * 4);
  expect("오픈 미팅 좌석(가정)", sum.openMeetingSeats, P.roundTables.length * P.roundTable.seats);
  return [...issues, ...validateSceneLayout(scene)];
}

