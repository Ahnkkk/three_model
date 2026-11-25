import type { DoorSpec, Vec2 } from "./sceneTypes";

/**
 * 사무실(H형 데스크 2세트 + 원형테이블 2개) 도면 데이터.
 *
 * 도면 좌표 (u, v): 외곽 왼쪽 위가 (0, 0), 오른쪽(동쪽) +u, 아래(남쪽) +v, 단위 m.
 * 3D 변환은 officeLayout.ts의 planToWorld(x = u - 9, z = v - 4)에서만 수행한다.
 *
 * 첨부 이미지의 표시 치수(5.0 / 10.0 / 3.0 / 8.0 / 3.6 / 3.4 / 3.6 / 4.0m)와 수량을 기준으로 하고,
 * 이미지에 치수가 없는 항목(창·문·가구 크기, 좌석 수 일부)은 아래 ASSUMPTIONS에 기록한 가정값이다.
 * 시공 도면이 아니며, 확인되면 이 파일의 값만 수정한다.
 */

export interface PlanZone {
  id: string;
  label: string;
  sub?: string;
  /** [u0, v0, u1, v1] */
  rect: [number, number, number, number];
  labelAt?: Vec2;
  /** 바닥 마감을 바꾸는 영역 */
  floor?: "loungeCarpet" | "pantryTile";
  /** 이미지로 확정할 수 없는 가정 영역 */
  assumption?: boolean;
}

export interface PlanPartition {
  id: string;
  kind: "glass" | "solid";
  a: Vec2;
  b: Vec2;
  openings?: { id: string; offset: number; width: number; height?: number; door?: DoorSpec }[];
}

export interface PlanDimension {
  side: "top" | "bottom" | "left" | "right";
  from: number;
  to: number;
  label: string;
  assumption?: boolean;
}

export const OFFICE_PLAN = {
  width: 18,
  depth: 8,
  height: 2.8,
  wallThickness: 0.2,

  zones: [
    { id: "large-meeting", label: "대회의실", sub: "14인석", rect: [0, 0, 5, 8], labelAt: [2.5, 7.25] },
    { id: "work-area", label: "메인 업무공간", sub: "10 × 4 m", rect: [5, 0, 15, 4], labelAt: [9.65, 3.62] },
    { id: "small-meeting", label: "소회의실", sub: "6인석", rect: [5, 4, 8.6, 8], labelAt: [6.8, 7.35] },
    { id: "open-meeting", label: "오픈 미팅공간", sub: "4 × 4 m", rect: [8.6, 4, 12.6, 8], labelAt: [9.75, 7.6] },
    { id: "entry-circulation", label: "입구 연결", rect: [12.6, 4, 15, 8], assumption: true },
    { id: "lounge", label: "휴게라운지", sub: "3 × 3.6 m", rect: [15, 0, 18, 3.6], labelAt: [15.95, 3.05], floor: "loungeCarpet" },
    { id: "right-buffer", label: "조정 구간", sub: "1.0 m (가정)", rect: [15, 3.6, 18, 4.6], labelAt: [16.9, 4.1], assumption: true },
    { id: "pantry", label: "탕비 영역", sub: "3 × 3.4 m", rect: [15, 4.6, 18, 8], labelAt: [16.5, 7.35], floor: "pantryTile" },
  ] satisfies PlanZone[] as PlanZone[],

  dimensions: [
    { side: "top", from: 0, to: 5, label: "5.0 m" },
    { side: "top", from: 5, to: 15, label: "10.0 m" },
    { side: "top", from: 15, to: 18, label: "3.0 m" },
    { side: "left", from: 0, to: 8, label: "8.0 m" },
    { side: "right", from: 0, to: 3.6, label: "3.6 m" },
    { side: "right", from: 3.6, to: 4.6, label: "1.0", assumption: true },
    { side: "right", from: 4.6, to: 8, label: "3.4 m" },
    { side: "bottom", from: 5, to: 8.6, label: "3.6 m" },
    { side: "bottom", from: 8.6, to: 12.6, label: "4.0 m" },
  ] satisfies PlanDimension[] as PlanDimension[],

  /** 서쪽 외벽 반복 창(대회의실). v = 창 중심 */
  windows: { centers: [1.1, 3.0, 4.95, 6.9], width: 1.3, bottom: 0.85, height: 1.45 },
  /** 창 사이 실내 쪽 기둥 */
  piers: { centers: [2.05, 3.975, 5.925], width: 0.5, depth: 0.18 },

  /** 남쪽 외벽 출입구 */
  entrance: {
    u: 14.25,
    width: 1.0,
    height: 2.15,
    door: { leaf: "paint", hinge: "start", swing: "pos", angle: 75 } satisfies DoorSpec as DoorSpec,
  },

  partitions: [
    {
      id: "large-meeting-east",
      kind: "glass",
      a: [5, 0],
      b: [5, 8],
      openings: [{ id: "large-meeting-door", offset: 0.85, width: 0.9, door: { leaf: "glass", hinge: "start", swing: "pos", angle: 60 } }], // 회의실 안쪽(서쪽)으로 열림
    },
    {
      id: "small-meeting-north",
      kind: "glass",
      a: [5, 4],
      b: [8.6, 4],
      openings: [{ id: "small-meeting-door", offset: 3.0, width: 0.9, door: { leaf: "glass", hinge: "end", swing: "pos", angle: 55 } }], // 회의실 안쪽(남쪽)으로 열림
    },
    { id: "small-meeting-east", kind: "glass", a: [8.6, 4], b: [8.6, 8] },
    { id: "lounge-west", kind: "solid", a: [15, 0], b: [15, 3.6] },
    { id: "lounge-south", kind: "solid", a: [15, 3.6], b: [18, 3.6], openings: [{ id: "lounge-entry", offset: 1.85, width: 0.9 }] },
    {
      id: "buffer-west",
      kind: "solid",
      a: [15, 3.6],
      b: [15, 4.6],
      // 이미지의 나무문. 조정 구간을 막지 않도록 열린 상태로 둔다.
      openings: [{ id: "buffer-door", offset: 0.5, width: 0.82, door: { leaf: "wood", hinge: "start", swing: "neg", angle: 80 } }],
    },
    { id: "pantry-north", kind: "solid", a: [15, 4.6], b: [18, 4.6] },
    { id: "pantry-west-solid", kind: "solid", a: [15, 4.6], b: [15, 6.2] },
    { id: "pantry-west-glass", kind: "glass", a: [15, 6.2], b: [15, 8], openings: [{ id: "pantry-entry", offset: 1.25, width: 0.9 }] },
    { id: "entry-stub", kind: "solid", a: [13.6, 7.0], b: [13.6, 8.0] },
  ] satisfies PlanPartition[] as PlanPartition[],

  /* ------------------------------ 가구 ------------------------------ */

  conference: { id: "large-table", center: [2.5, 3.9] as Vec2, width: 1.2, length: 4.8, ports: 2, perSide: 6, ends: 1, spacing: 0.75, chairColor: "#5c5650" },
  smallMeeting: { id: "small-table", center: [6.8, 6.05] as Vec2, width: 0.95, length: 1.6, ports: 0, perSide: 2, ends: 1, spacing: 0.78, chairColor: "#5c5650" },
  hDesks: [
    { id: "h1", label: "H형 ①", center: [7.4, 2.05] as Vec2 },
    { id: "h2", label: "H형 ②", center: [11.9, 2.05] as Vec2 },
  ],
  /** H형 한 세트: [폭, 높이, 깊이]. 세트당 좌석 4개(이미지 기준 가정) */
  hDeskSize: [3.3, 0.74, 2.6] as [number, number, number],
  hDeskChairColor: "#2c2c2f",
  roundTables: [
    { id: "round-1", center: [10.0, 5.45] as Vec2 },
    { id: "round-2", center: [11.85, 6.7] as Vec2 },
  ],
  roundTable: { diameter: 1.0, height: 0.74, seats: 3, chairColor: "#b9b2a9" },
  benches: [
    { id: "bench-west", center: [0.55, 3.9] as Vec2, length: 5.2, facing: "east" as const },
    { id: "bench-east", center: [4.55, 4.0] as Vec2, length: 4.8, facing: "west" as const },
  ],
  bench: { depth: 0.55, height: 0.78, color: "#9b968e" },
  credenza: { center: [2.6, 7.75] as Vec2, size: [2.4, 0.5, 0.4] as [number, number, number] },
  lounge: {
    sofa: { center: [16.5, 0.48] as Vec2, size: [2.0, 0.82, 0.86] as [number, number, number], color: "#bdb5aa" },
    table: { center: [16.25, 2.0] as Vec2, size: [0.7, 0.42, 0.7] as [number, number, number] },
    armchair: { center: [17.3, 2.55] as Vec2, size: [0.78, 0.8, 0.78] as [number, number, number], rotation: -120, color: "#ece5d8" },
  },
  pantry: { center: [16.5, 4.96] as Vec2, size: [2.8, 0.9, 0.6] as [number, number, number] },

  /** 실내 모드 천장등(u, v) */
  ceilingLights: [
    [2.5, 2.2],
    [2.5, 5.8],
    [7.4, 2.0],
    [11.9, 2.0],
    [6.8, 6.0],
    [10.9, 6.1],
    [16.5, 1.8],
    [16.5, 6.3],
  ] as Vec2[],

  /** 3D 설명 표식(HTML 오버레이). 메시에 글자를 굽지 않는다. */
  annotations: [
    { id: "h1", label: "H형 ①", at: [7.4, 2.05] as Vec2, y: 1.7, arrow: "down" as const },
    { id: "h2", label: "H형 ②", at: [11.9, 2.05] as Vec2, y: 1.7, arrow: "down" as const },
    { id: "entrance", label: "입구", at: [14.25, 8.45] as Vec2, y: 0.05, arrow: "up" as const },
  ],
} as const;

/** 이미지로 확정할 수 없어 가정한 항목(README·화면에 함께 표시) */
export const OFFICE_ASSUMPTIONS: string[] = [
  "전체 외곽은 표시 치수대로 18 × 8m로 둡니다(벽 두께 0.2m는 외곽 바깥쪽에 둡니다).",
  "오른쪽 세로 3.6 + 3.4m와 8.0m의 차이 1.0m는 라운지와 탕비 사이 조정 구간으로 둡니다. 나무문은 열어 두어 막지 않습니다.",
  "소회의실 깊이 4m, 입구 연결 공간 2.4m는 도면 배분을 위한 가정입니다.",
  "H형 좌석은 세트당 4석(총 8석), 원형 테이블은 테이블당 3석으로 둡니다.",
  "서쪽 창은 4개(폭 1.3m), 출입문 폭 1.0m, 실내문 폭 0.82~0.9m, 벽 높이는 2.8m로 둡니다.",
  "라운지는 조정 구간 쪽 개구부, 탕비는 입구 쪽 서측 개구부로 출입한다고 가정합니다.",
];
