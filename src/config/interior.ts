/**
 * 실내 장면 설정.
 *
 * - 단위: 1 = 1m, 회전은 도(degree) 단위로 기록하고 런타임에서 라디안으로 변환한다.
 * - 배치·조명·시점·베이크 설정을 이 파일에 모아 두고 컴포넌트에는 흩어 놓지 않는다.
 * - 가구는 기본적으로 절차적(코드) 모델을 사용하며, `model`에 GLB 경로를 지정하면 해당 모델로 교체된다.
 *   (모델 로딩 실패 시 절차적 모델로 대체하고 경고를 표시한다.)
 */

import type { MaterialId, RoomSurfaceId } from "./materials";
import type { BakeConfig, CameraConfig, FurnitureItem, LampLight, LightingConfig, SceneConfig, Vec3, ViewPreset, WallOpening } from "./sceneTypes";

// 공용 타입은 sceneTypes.ts로 옮기고, 기존 import 경로를 유지하기 위해 다시 export 한다.
export type { FurnitureItem, FurnitureKind, LampLight, Vec3, ViewPreset, WallId, WallOpening } from "./sceneTypes";

/* ------------------------------------------------------------------ */
/* 방 구조                                                             */
/* ------------------------------------------------------------------ */

export const ROOM = {
  width: 6, // x
  depth: 5, // z
  height: 2.8, // y
  wallThickness: 0.15,
  baseboardHeight: 0.08,
  openings: [
    // 왼쪽(west) 벽의 큰 창. 월드 z = depth/2 - center = -0.4
    { id: "main-window", wall: "west", kind: "window", center: 2.9, bottom: 0.55, width: 2.4, height: 1.75 },
  ] satisfies WallOpening[] as WallOpening[],
} as const;

/* ------------------------------------------------------------------ */
/* 가구·소품                                                           */
/* ------------------------------------------------------------------ */

export const FURNITURE: FurnitureItem[] = [
  { id: "rug", kind: "rug", label: "러그", position: [0.4, 0, -0.85], size: [2.8, 0.012, 2.0], bake: { occlude: false }, castShadow: false },
  { id: "sofa", kind: "sofa", label: "소파", position: [0.4, 0, -1.98], size: [2.2, 0.82, 0.92], variant: { color: "#8a8f86" }, bake: { strength: 0.6, radius: 0.22 } },
  { id: "coffee-table", kind: "coffeeTable", label: "커피 테이블", position: [0.4, 0, -0.72], size: [1.1, 0.4, 0.6], bake: { strength: 0.4, radius: 0.18 } },
  { id: "armchair", kind: "armchair", label: "암체어", position: [-1.85, 0, -0.45], rotationY: 90, size: [0.85, 0.8, 0.85], variant: { color: "#b5855a" }, bake: { strength: 0.55, radius: 0.2 } },
  { id: "side-table", kind: "sideTable", label: "사이드 테이블", position: [-1.1, 0, -2.12], size: [0.45, 0.55, 0.45], bake: { strength: 0.35, radius: 0.12 } },
  { id: "plant-small", kind: "plant", label: "작은 화분", position: [-1.1, 0.55, -2.12], size: [0.26, 0.42, 0.26], variant: { seed: 7 }, bake: { occlude: false } },
  { id: "tv-console", kind: "tvConsole", label: "TV 콘솔", position: [0.4, 0, 2.27], rotationY: 180, size: [1.9, 0.48, 0.42], bake: { strength: 0.55, radius: 0.18 } },
  { id: "tv", kind: "tv", label: "TV", position: [0.4, 0.48, 2.3], rotationY: 180, size: [1.3, 0.82, 0.22], bake: { occlude: false } },
  { id: "bookshelf", kind: "bookshelf", label: "책장", position: [2.8, 0, 0.1], rotationY: -90, size: [1.6, 2.0, 0.36], bake: { strength: 0.6, radius: 0.2 } },
  { id: "floor-lamp", kind: "floorLamp", label: "플로어 램프", position: [1.85, 0, -2.15], size: [0.42, 1.65, 0.42], bake: { strength: 0.3, radius: 0.12 } },
  { id: "pendant", kind: "pendantLamp", label: "펜던트 조명", position: [0.4, 1.85, -0.72], size: [0.48, 0.95, 0.48], bake: { occlude: false }, castShadow: false },
  { id: "plant-large", kind: "plant", label: "큰 화분", position: [-2.55, 0, -2.05], size: [0.6, 1.35, 0.6], variant: { seed: 3 }, bake: { strength: 0.45, radius: 0.16 } },
  { id: "art-1", kind: "wallArt", label: "액자 1", position: [-0.05, 1.18, -2.5], size: [0.7, 0.9, 0.03], variant: { seed: 11 }, bake: { occlude: false } },
  { id: "art-2", kind: "wallArt", label: "액자 2", position: [0.95, 1.33, -2.5], size: [0.5, 0.62, 0.03], variant: { seed: 23 }, bake: { occlude: false } },
  { id: "door", kind: "door", label: "문", position: [-1.9, 0, 2.5], rotationY: 180, size: [0.92, 2.1, 0.05], bake: { occlude: false } },
];

/* ------------------------------------------------------------------ */
/* 조명                                                                */
/* ------------------------------------------------------------------ */

export const LIGHTING = {
  sun: {
    position: [-7, 6.5, 1.2] as Vec3,
    target: [0, 0, -0.4] as Vec3,
    color: "#fff0d9",
    intensity: 3.2,
    shadow: { bias: -0.0004, normalBias: 0.02, cameraExtent: 5.5 },
  },
  lamps: [
    { id: "floor-lamp-light", fixtureId: "floor-lamp", position: [1.85, 1.48, -2.15], color: "#ffc98a", intensity: 2.6, castShadow: false },
    { id: "pendant-light", fixtureId: "pendant", position: [0.4, 1.9, -0.72], color: "#ffd7a3", intensity: 3.2, castShadow: false },
  ] satisfies LampLight[] as LampLight[],
  /** 램프와 함께 켜고 끄는 발광 재질 */
  emissiveMaterials: ["lampShade", "bulb"] as MaterialId[],
  /** 창밖 하늘·풍경 배경의 밝기 배율(배경 표시용, 조명 계산에는 사용하지 않음) */
  skyLuminance: 1.15,
  /**
   * 환경광(IBL) 강도.
   * 라이트맵이 켜진 방 표면은 간접 확산광을 라이트맵이 담당하므로 환경광을 줄여 중복을 피한다.
   */
  environment: {
    intensity: 0.9,
    /** 환경맵 캡처용 창(면광원) 휘도 */
    windowLuminance: 4.5,
    roomSurfaceIntensityWithLightmap: 0.25,
  },
} as const;

/* ------------------------------------------------------------------ */
/* 라이트맵(간이 베이크)                                               */
/* ------------------------------------------------------------------ */

/**
 * 실제 라이트맵 베이크(Blender 등) 결과가 준비되기 전까지 사용하는 프로토타입용 간이 베이크 설정.
 * 간접광만 담는다(직접광은 실시간 조명이 담당 → 직접광 중복 방지).
 * 실제 베이크 텍스처를 쓰는 경우 `source: "file"`과 표면별 경로를 지정하는 방식으로 확장한다.
 */
export const BAKE = {
  texelsPerMeter: 28,
  ambient: [0.16, 0.15, 0.14] as Vec3,
  sky: { color: [0.62, 0.74, 1.0] as Vec3, power: 0.55, grid: 4 },
  sunBounce: { albedo: [0.52, 0.36, 0.22] as Vec3, power: 0.18, grid: 5 },
  lampBounce: { power: 0.06, softening: 0.9 },
  edgeOcclusion: { strength: 0.38, radius: 0.32 },
  furnitureOcclusion: { strength: 0.5, radius: 0.18 },
  softening: 0.55,
} as const;

/* ------------------------------------------------------------------ */
/* 카메라                                                              */
/* ------------------------------------------------------------------ */

export const CAMERA = {
  fov: 55,
  near: 0.05,
  far: 60,
  minDistance: 0.4,
  maxDistance: 4.6,
  minPolarAngle: 0.12 * Math.PI,
  maxPolarAngle: 0.86 * Math.PI,
  /** 카메라 위치 허용 범위(벽 안쪽 여유 포함) */
  positionBounds: { min: [-2.8, 0.3, -2.3] as Vec3, max: [2.8, 2.55, 2.3] as Vec3 },
  /** 회전 중심(target) 허용 범위 */
  targetBounds: { min: [-2.6, 0.2, -2.2] as Vec3, max: [2.6, 2.3, 2.2] as Vec3 },
  defaultView: "overview",
  views: [
    { id: "overview", label: "전체", position: [2.35, 1.65, 2.05], target: [-0.3, 0.8, -0.8] },
    { id: "sofa", label: "소파", position: [0.4, 1.15, -1.45], target: [0.4, 0.95, 2.3] },
    { id: "window", label: "창가", position: [1.3, 1.35, 0.9], target: [-3, 1.05, -0.6] },
    { id: "shelf", label: "책장", position: [-0.3, 1.45, 1.15], target: [2.8, 1.0, 0.1] },
  ] satisfies ViewPreset[] as ViewPreset[],
  transitionSeconds: 1.1,
  /** 키보드 시점 이동(6 × 5m 방 기준) */
  keyboard: { moveSpeed: 1.2, turnSpeed: 70, bodyRadius: 0.2, jumpHeight: 0.9 },
} as const;

/* ------------------------------------------------------------------ */
/* 장면 설정(거실)                                                     */
/* ------------------------------------------------------------------ */

/** 기존 거실 재질 목록(리소스 준비 단계에서 모두 미리 생성 — 기존 동작 유지) */
const LIVING_MATERIALS: MaterialId[] = [
  "floorWood", "wallPlaster", "ceiling", "baseboard", "walnut", "oakLight", "fabric", "leather", "marble", "blackMetal",
  "brass", "rug", "ceramic", "soil", "leaf", "screen", "plasticDark", "lampShade", "bulb", "glass", "windowFrame",
  "doorPaint", "canvasWhite", "books",
];

const LIVING_SURFACES: Record<RoomSurfaceId, MaterialId> = {
  floor: "floorWood",
  ceiling: "ceiling",
  north: "wallPlaster",
  south: "wallPlaster",
  west: "wallPlaster",
  east: "wallPlaster",
};

export const LIVING_SCENE: SceneConfig = {
  id: "living",
  title: "거실",
  shell: "living",
  standalone: true,
  room: ROOM,
  furniture: FURNITURE,
  partitions: [],
  floorZones: [],
  lighting: LIGHTING satisfies LightingConfig,
  bake: BAKE satisfies BakeConfig,
  camera: CAMERA satisfies CameraConfig,
  surfaceMaterials: LIVING_SURFACES,
  preloadMaterials: LIVING_MATERIALS,
  environmentPalette: { wall: "#d9cfc2", floor: "#a87c55", ceiling: "#f2efe9" },
  annotations: [],
  defaultMode: "interior",
};
