import type { MaterialId, RoomSurfaceId } from "./materials";

/**
 * 장면 공용 타입.
 *
 * 장면(거실·사무실)마다 설정 객체 하나(SceneConfig)를 만들고, 렌더링·베이크·카메라·2D 평면도가
 * 모두 이 객체를 인자로 받는다. 전역 상수를 바꿔 읽는 방식은 쓰지 않는다.
 *
 * 좌표: 1 = 1m, +Y 위, 서쪽 -X, 동쪽 +X, 북쪽 -Z, 남쪽 +Z. 회전은 Y축 도(degree) 단위.
 */

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

/** 장면 ID. 거실("living")·사무실("office")과 외부 도면 문서의 ID를 모두 받는다. */
export type SceneId = string;
/**
 * 외곽 표현 방식.
 * - living: 얇은 벽면 + 천장(거실 프로토타입)
 * - plan: 두께가 있는 외벽·단면 조감도·내부 벽(사무실과 외부 도면)
 */
export type ShellKind = "living" | "plan";
/** interior = 닫힌 실내(천장·전체 벽), aerial = 천장 없는 조감도(전면 벽 단면) */
export type DisplayMode = "interior" | "aerial";
export type BakeVariant = "closed" | "open";

/* ------------------------------ 방·개구부 ------------------------------ */

/** north = 뒤(z-), south = 앞(z+), west = 왼쪽(x-), east = 오른쪽(x+) */
export type WallId = "north" | "south" | "west" | "east";

/**
 * 문짝 설정.
 * - hinge: 개구부의 어느 쪽 끝에 경첩이 있는지(벽·파티션 로컬 +x 기준 start/end)
 * - swing: 열리는 쪽(로컬 +z = pos, -z = neg). 외벽에서 +z는 실내 방향이다.
 * - angle: 열린 각도(도). 0이면 닫힘.
 */
export interface DoorSpec {
  leaf: "glass" | "wood" | "paint" | "none";
  hinge: "start" | "end";
  swing: "pos" | "neg";
  angle: number;
}

export interface WallOpening {
  id: string;
  wall: WallId;
  kind: "window" | "door";
  /** 벽 로컬 좌표(실내에서 바라본 벽의 왼쪽 끝 기준)에서 개구부 중심까지의 거리 */
  center: number;
  /** 바닥에서 개구부 하단까지의 높이(문은 0) */
  bottom: number;
  width: number;
  height: number;
  door?: DoorSpec;
}

export interface RoomConfig {
  width: number; // x
  depth: number; // z
  height: number; // y
  wallThickness: number;
  baseboardHeight: number;
  openings: WallOpening[];
}

/* ------------------------------ 파티션 ------------------------------ */

export interface PartitionOpening {
  id: string;
  /** 선분 시작점(a)에서 개구부 중심까지의 거리 */
  offset: number;
  width: number;
  height: number;
  door?: DoorSpec;
}

/** 시작점·끝점(월드 xz)·높이·두께·재질 종류·개구부를 가진 벽 선분. 2D와 3D가 같은 데이터를 쓴다. */
export interface PartitionSegment {
  id: string;
  kind: "glass" | "solid";
  a: Vec2;
  b: Vec2;
  thickness: number;
  /** 생략 시 방 높이 */
  height?: number;
  openings: PartitionOpening[];
}

/* ------------------------------ 가구 ------------------------------ */

export type FurnitureKind =
  // 거실
  | "sofa"
  | "armchair"
  | "coffeeTable"
  | "sideTable"
  | "tvConsole"
  | "tv"
  | "bookshelf"
  | "floorLamp"
  | "pendantLamp"
  | "plant"
  | "rug"
  | "wallArt"
  | "door"
  // 사무실
  | "conferenceTable"
  | "meetingChair"
  | "officeChair"
  | "hDesk"
  | "roundMeetingTable"
  | "bench"
  | "lowCabinet"
  | "pantryCounter"
  // 도면에서 종류를 분류하지 못한 가구(단순 박스로 표시)
  | "unknown";

export interface FurnitureItem {
  id: string;
  kind: FurnitureKind;
  label: string;
  /** 바닥 중심(bottom-center) 기준 위치 */
  position: Vec3;
  /** Y축 회전(도). 0이면 정면이 +z를 향한다. */
  rotationY?: number;
  /** 바운딩 박스 크기 [폭(x), 높이, 깊이(z)]. 절차적 모델 치수·베이크 차폐·2D 평면도에 함께 사용한다. */
  size: Vec3;
  /** GLB 교체 경로(public 기준). 지정 시 모델을 size에 맞게 배치한다. */
  model?: { url: string; fitToSize?: boolean };
  /** 절차적 모델 변형값 */
  variant?: { color?: string; seed?: number; ports?: number };
  /** 라이트맵 베이크 시 접촉 차폐(contact occlusion) 설정. 생략 시 기본값. */
  bake?: { occlude?: boolean; strength?: number; radius?: number };
  castShadow?: boolean;
  /** 가구 그룹(H형 데스크·회의 테이블 좌석 등)과 공간 영역 식별자 */
  group?: string;
  zone?: string;
}

/* ------------------------------ 조명·베이크 ------------------------------ */

export interface LampLight {
  id: string;
  /** 연결된 가구 id(발광 표면 표시용, 선택) */
  fixtureId?: string;
  position: Vec3;
  color: string;
  /** 칸델라 단위(물리 기반 조명, decay = 2) */
  intensity: number;
  castShadow: boolean;
}

export interface SunConfig {
  position: Vec3;
  target: Vec3;
  color: string;
  intensity: number;
  /** cameraExtent 생략 시 방 크기로 계산 */
  shadow: { bias: number; normalBias: number; cameraExtent?: number };
}

export interface LightingConfig {
  sun: SunConfig;
  lamps: LampLight[];
  /** 램프와 함께 켜고 끄는 발광 재질 */
  emissiveMaterials: MaterialId[];
  /** 창밖 배경 밝기 배율(배경 표시용) */
  skyLuminance: number;
  environment: {
    intensity: number;
    /** 환경맵 캡처용 창(면광원) 휘도 */
    windowLuminance: number;
    /** 라이트맵이 켜진 방 표면의 환경광 강도(간접 확산광 중복 방지) */
    roomSurfaceIntensityWithLightmap: number;
  };
}

export interface BakeConfig {
  texelsPerMeter: number;
  ambient: Vec3;
  sky: { color: Vec3; power: number; grid: number };
  sunBounce: { albedo: Vec3; power: number; grid: number };
  lampBounce: { power: number; softening: number };
  edgeOcclusion: { strength: number; radius: number };
  furnitureOcclusion: { strength: number; radius: number };
  partitionOcclusion?: { strength: number; radius: number };
  softening: number;
  /** 천장 없는 조감도(open) 변형에서 위쪽 하늘을 면광원으로 근사 */
  openSky?: { color: Vec3; power: number; grid: Vec2; floorBounce: number };
}

/* ------------------------------ 카메라 ------------------------------ */

export interface ViewPreset {
  id: string;
  label: string;
  position: Vec3;
  target: Vec3;
  /** true면 position-target 방향을 유지하고 거리를 방 전체 bounds와 화면 비율에 맞춰 계산 */
  fit?: boolean;
}

export interface CameraConfig {
  fov: number;
  near: number;
  far: number;
  minDistance: number;
  maxDistance: number;
  minPolarAngle: number;
  maxPolarAngle: number;
  positionBounds: { min: Vec3; max: Vec3 };
  targetBounds: { min: Vec3; max: Vec3 };
  defaultView: string;
  views: ViewPreset[];
  transitionSeconds: number;
  /**
   * 1인칭(걷기) 조작. 있으면 3D 게임처럼 눈이 회전 중심이 된다 — 드래그 제자리 회전, 휠 화면 중심 확대·축소,
   * W·A·S·D 보는 방향 기준 앞·왼쪽·뒤·오른쪽, 방향키·Q·E 제자리 시점 회전(turnSpeed), Shift 빠르게, Space 점프(lib/three/firstPerson.ts).
   * 생략하면 OrbitControls(대상 주위 회전)를 쓴다(예: 사무실 조감도 — 페이지 스크롤과 충돌하지 않게).
   */
  keyboard?: {
    /** 이동 속도(m/s) */
    moveSpeed: number;
    /** 회전 속도(도/s) */
    turnSpeed: number;
    /** 보행 충돌 반지름(m). 카메라를 이 반지름의 원으로 보고 가구·파티션·문짝을 통과하지 않게 한다(lib/three/collision.ts). */
    bodyRadius: number;
    /** Space 점프 최고 높이(m). 카메라 위치 범위의 위쪽 한계를 넘지 않는다. */
    jumpHeight: number;
  };
}

/* ------------------------------ 표시 모드 ------------------------------ */

export interface DisplayModeConfig {
  label: string;
  camera: CameraConfig;
  sun: SunConfig;
  bakeVariant: BakeVariant;
  showCeiling: boolean;
  /** 벽 높이 절단(조감도 단면). 생략한 벽은 방 높이 그대로 */
  wallCut: Partial<Record<WallId, number>>;
  /** 장면 배경색. null이면 렌더러 기본값 */
  background: string | null;
  environmentScale: number;
  lampScale: number;
  annotations: boolean;
  /** 우측 상단 미니맵(평면도 + 현재 위치·시선). 걸어 다니는 실내 화면에서 켠다. */
  minimap: boolean;
}

/* ------------------------------ 장면 ------------------------------ */

export interface SceneAnnotation {
  id: string;
  label: string;
  position: Vec3;
  /** 표식 화살표 방향(아래: 위에서 대상을 가리킴, 위: 아래에서 대상을 가리킴) */
  arrow?: "down" | "up";
}

/** 바닥 마감이 다른 영역(바닥 라이트맵을 함께 사용) */
export interface FloorZone {
  id: string;
  material: MaterialId;
  /** 월드 [x0, z0, x1, z1] */
  rect: [number, number, number, number];
}

/** 천장까지 닿는 직사각 기둥(월드 xz 중심, 크기 [x, z]) */
export interface SceneColumn {
  id: string;
  center: Vec2;
  size: Vec2;
}

/** 2D 평면도의 영역 표시(월드 좌표) */
export interface PlanZoneView {
  id: string;
  label: string;
  sub?: string;
  /** 월드 [x0, z0, x1, z1] */
  rect: [number, number, number, number];
  /** 공간명 위치(생략하면 표시하지 않음) */
  labelAt?: Vec2;
  /** 바닥 마감(2D 색) */
  material?: MaterialId;
  /** 도면으로 확정할 수 없는 가정 영역(점선) */
  assumption?: boolean;
}

/** 2D 평면도의 치수선. from·to는 해당 축의 월드 좌표(top·bottom = x, left·right = z) */
export interface PlanDimensionView {
  side: "top" | "bottom" | "left" | "right";
  from: number;
  to: number;
  label: string;
  assumption?: boolean;
}

/** 2D 평면도 바깥에서 대상을 가리키는 이름표(top·bottom 여백에서 tipZ까지 화살표) */
export interface PlanCallout {
  id: string;
  label: string;
  x: number;
  side: "top" | "bottom";
  tipZ: number;
}

/** 2D 평면도 전용 표시 정보(3D에는 쓰지 않음) */
export interface PlanView {
  zones: PlanZoneView[];
  dimensions: PlanDimensionView[];
  callouts: PlanCallout[];
}

export interface SceneConfig {
  id: SceneId;
  /** 같은 id의 수정 버전. 바뀌면 리소스·시점을 새로 준비한다(sceneKey). 생략하면 0 */
  revision?: number;
  title: string;
  shell: ShellKind;
  /** 전체 화면 단독 뷰어(거실): 설정·통계 패널을 펼친 채 시작하고 통계를 접지 않는다 */
  standalone?: boolean;
  room: RoomConfig;
  furniture: FurnitureItem[];
  partitions: PartitionSegment[];
  /** 천장까지 닿는 기둥(plan 외곽에서 표시) */
  columns?: SceneColumn[];
  floorZones: FloorZone[];
  /** 2D 평면도 표시 정보(영역·치수·이름표) */
  plan?: PlanView;
  lighting: LightingConfig;
  bake: BakeConfig;
  /** 모드 설정이 없을 때(거실) 사용하는 카메라 */
  camera: CameraConfig;
  surfaceMaterials: Record<RoomSurfaceId, MaterialId>;
  /** 리소스 준비 단계에서 미리 만들 재질(나머지는 처음 쓰일 때 생성) */
  preloadMaterials: MaterialId[];
  /** 실내형 환경맵 캡처용 단순 색 */
  environmentPalette: { wall: string; floor: string; ceiling: string };
  annotations: SceneAnnotation[];
  defaultMode: DisplayMode;
  modes?: Partial<Record<DisplayMode, DisplayModeConfig>>;
  /** 미니맵에 표시할 공간 이름(월드 xz). 생략하면 이름 없이 평면만 그린다. */
  mapLabels?: { id: string; text: string; at: Vec2 }[];
}

/** 장면 식별 키(id + revision). 뷰어 상태·Canvas·초기 시점·리소스가 이 키가 바뀔 때 새로 준비된다. */
export function sceneKey(scene: Pick<SceneConfig, "id" | "revision">): string {
  return `${scene.id}@${scene.revision ?? 0}`;
}

export interface ResolvedScene extends SceneConfig {
  mode: DisplayMode;
  view: DisplayModeConfig;
}

/** 장면 + 표시 모드 → 실제 적용 값. 모드 설정이 없는 장면(거실)은 기존 값 그대로 사용한다. */
export function resolveDisplayMode(scene: SceneConfig, mode: DisplayMode): DisplayModeConfig {
  const configured = scene.modes?.[mode] ?? scene.modes?.[scene.defaultMode];
  if (configured) return configured;
  return {
    label: "실내",
    camera: scene.camera,
    sun: scene.lighting.sun,
    bakeVariant: "closed",
    showCeiling: true,
    wallCut: {},
    background: null,
    environmentScale: 1,
    lampScale: 1,
    annotations: false,
    minimap: true,
  };
}

export function availableModes(scene: SceneConfig): DisplayMode[] {
  return scene.modes ? (Object.keys(scene.modes) as DisplayMode[]) : [scene.defaultMode];
}

export function bakeVariantsOf(scene: SceneConfig): { variant: BakeVariant; sun: SunConfig }[] {
  const out = new Map<BakeVariant, SunConfig>();
  for (const mode of availableModes(scene)) {
    const m = resolveDisplayMode(scene, mode);
    if (!out.has(m.bakeVariant)) out.set(m.bakeVariant, m.sun);
  }
  return [...out.entries()].map(([variant, sun]) => ({ variant, sun }));
}
