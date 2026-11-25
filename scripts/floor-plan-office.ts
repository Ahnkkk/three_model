/**
 * 기존 사무실(officePlan.ts → OFFICE_SCENE)을 FloorPlanDocument v1로 다시 표현한다.
 *
 * 결과는 examples/floor-plans/office.json(첫 정상 예제)으로 저장한다(npm run schema:floor-plan).
 * S2의 FloorPlanDocument → SceneConfig 어댑터는 이 문서로 기존 OFFICE_SCENE·verify:office 결과를 재현해야 한다.
 *
 * 도면 규격에 없는 렌더링 설정(천장등·카메라·베이크·3D 표식·가구 색·베이크 차폐)은 옮기지 않는다.
 */
import { OFFICE_ASSUMPTIONS, OFFICE_PLAN } from "../src/config/officePlan";
import { OFFICE_SCENE } from "../src/config/officeScene";
import type { FloorPlanDocument } from "../src/lib/floorPlan/schema";
import { FLOOR_PLAN_SCHEMA_FILE } from "../src/lib/floorPlan/schema";
import { worldToPlan } from "../src/lib/three/officeLayout";

/** 0.1mm 반올림(월드 → 도면 변환의 부동소수 잔여 제거) */
const q = (n: number) => Math.round(n * 1e4) / 1e4 + 0;

export function buildOfficeFloorPlanDocument(): FloorPlanDocument {
  const P = OFFICE_PLAN;
  const scene = OFFICE_SCENE;

  const walls: FloorPlanDocument["walls"] = scene.partitions.map((p) => {
    const plan = P.partitions.find((x) => x.id === p.id)!;
    return { id: p.id, kind: p.kind, start: [...plan.a], end: [...plan.b], thickness: p.thickness };
  });

  const openings: FloorPlanDocument["openings"] = [
    ...scene.room.openings.map((o) => ({
      id: o.id,
      wallId: o.wall,
      kind: o.kind,
      // 외벽 개구부 center는 실내에서 본 벽 왼쪽 끝 기준 = FloorPlanDocument 외곽 벽 진행 방향의 시작점 기준
      offset: o.center,
      width: o.width,
      height: o.height,
      bottom: o.bottom,
      ...(o.door ? { door: { ...o.door } } : {}),
    })),
    ...scene.partitions.flatMap((p) =>
      p.openings.map((o) => ({
        id: o.id,
        wallId: p.id,
        kind: o.door && o.door.leaf !== "none" ? ("door" as const) : ("passage" as const),
        offset: o.offset,
        width: o.width,
        height: o.height,
        bottom: 0,
        ...(o.door ? { door: { ...o.door } } : {}),
      })),
    ),
  ];

  const columns: FloorPlanDocument["columns"] = P.piers.centers.map((v, i) => ({
    id: `west-pier-${i + 1}`,
    center: [q(P.piers.depth / 2), v],
    size: [P.piers.depth, P.piers.width],
  }));

  const furniture: FloorPlanDocument["furniture"] = scene.furniture.map((f) => {
    const [u, v] = worldToPlan(f.position[0], f.position[2]);
    return {
      id: f.id,
      kind: f.kind === "door" ? "unknown" : f.kind,
      label: f.label,
      position: [q(u), f.position[1], q(v)],
      size: [...f.size],
      ...(f.rotationY ? { rotation: f.rotationY } : {}),
      ...(f.group ? { group: f.group } : {}),
    };
  });

  const zones: FloorPlanDocument["zones"] = P.zones.map((z) => ({
    id: z.id,
    name: z.sub ? `${z.label} (${z.sub})` : z.label,
    rect: [...z.rect],
    ...(z.floor ? { finish: z.floor } : {}),
  }));
  const zonePath = (id: string) => `/zones/${P.zones.findIndex((z) => z.id === id)}`;

  return {
    $schema: `../../schemas/${FLOOR_PLAN_SCHEMA_FILE}`,
    schemaVersion: 1,
    id: "office",
    revision: 1,
    title: scene.title,
    unit: "m",
    envelope: { width: P.width, depth: P.depth, wallThickness: P.wallThickness },
    ceilingHeight: P.height,
    walls,
    openings,
    columns,
    furniture,
    zones,
    source: {
      kind: "manual",
      originalUnit: "m",
      note: "info.png(2D·3D 혼합 이미지)의 표시 치수와 수량을 사람이 읽어 src/config/officePlan.ts에 작성한 값을 옮겼다. 배율 보정은 하지 않았다.",
    },
    provenance: [
      { path: "/envelope/width", origin: "source", confirmed: true, note: "상단 표시 치수 5.0 + 10.0 + 3.0 m" },
      { path: "/envelope/depth", origin: "source", confirmed: true, note: "왼쪽 표시 치수 8.0 m" },
      { path: "/envelope/wallThickness", origin: "user", confirmed: false, note: OFFICE_ASSUMPTIONS[0] },
      { path: "/ceilingHeight", origin: "default", confirmed: false, note: "도면에 높이 표기가 없어 기본값 2.8m 사용" },
      { path: zonePath("right-buffer"), origin: "derived", confirmed: false, note: "전체 깊이 8.0m − (3.6 + 3.4)m" },
    ],
    issues: [
      {
        id: "right-dimension-sum",
        kind: "conflict",
        path: zonePath("right-buffer"),
        message: `오른쪽 세로 치수 합계 3.6 + 3.4 = 7.0m가 전체 깊이 8.0m보다 1.0m 짧다. ${OFFICE_ASSUMPTIONS[1]}`,
        resolved: false,
      },
      { id: "room-depths", kind: "assumption", path: zonePath("small-meeting"), message: OFFICE_ASSUMPTIONS[2], resolved: false },
      { id: "seat-counts", kind: "assumption", path: "/furniture", message: OFFICE_ASSUMPTIONS[3], resolved: false },
      { id: "opening-sizes", kind: "assumption", path: "/openings", message: OFFICE_ASSUMPTIONS[4], resolved: false },
      { id: "room-access", kind: "assumption", path: zonePath("lounge"), message: OFFICE_ASSUMPTIONS[5], resolved: false },
    ],
    completeness: { walls: "reviewed", openings: "reviewed", furniture: "reviewed" },
  };
}
