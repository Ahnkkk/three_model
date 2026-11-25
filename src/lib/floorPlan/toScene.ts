import type { MaterialId } from "@/config/materials";
import type {
  BakeConfig,
  CameraConfig,
  DisplayModeConfig,
  FurnitureItem,
  FurnitureKind,
  LampLight,
  PartitionSegment,
  SceneConfig,
  SunConfig,
  Vec2,
  Vec3,
  ViewPreset,
  WallId,
  WallOpening,
} from "@/config/sceneTypes";
import { activeColliders, buildColliders, nearestFreeSpot } from "@/lib/three/collision";
import { planPoint, wallPlanFrame } from "@/lib/three/planGeometry";
import { resolveWallJunctions } from "@/lib/three/wallJunctions";
import type { FloorPlanDocument } from "./schema";

/**
 * FloorPlanDocument(검증 통과) → SceneConfig 어댑터.
 *
 * 도면 좌표(u, v: 외곽 실내 왼쪽 위 원점, m) → 월드(x = u − 폭/2, z = v − 깊이/2)를 이 파일에서만 변환한다.
 * 도면에 없는 렌더링 설정(카메라·조명·베이크·재질)은 외곽 크기와 개구부에서 계산한다.
 * 내부 벽 접합은 wallJunctions.ts로 처리해 2D·3D·충돌이 같은 선분을 쓴다.
 * three.js에 의존하지 않는 순수 함수다(Node 검증 스크립트에서 실행).
 */

/** 형식·문서 검증을 통과한 문서만 넘긴다(validateFloorPlan의 ok·document). */
export function floorPlanToScene(doc: FloorPlanDocument): SceneConfig {
  const W = doc.envelope.width;
  const D = doc.envelope.depth;
  const H = doc.ceilingHeight;
  const toWorld = (u: number, v: number): Vec2 => [q(u - W / 2), q(v - D / 2)];
  const exteriorIds = new Set<string>(["north", "east", "south", "west"]);

  const openings: WallOpening[] = doc.openings
    .filter((o) => exteriorIds.has(o.wallId))
    .map((o) => ({
      id: o.id,
      wall: o.wallId as WallId,
      // 통로(문짝 없는 문)도 외벽에서는 바닥까지 뚫린 문 개구부로 만든다.
      kind: o.kind === "window" ? "window" : "door",
      center: o.offset,
      bottom: o.bottom,
      width: o.width,
      height: o.height,
      ...(o.door ? { door: { ...o.door } } : {}),
    }));

  const partitions: PartitionSegment[] = resolveWallJunctions(
    doc.walls.map((w) => ({
      id: w.id,
      kind: w.kind,
      a: toWorld(...w.start),
      b: toWorld(...w.end),
      thickness: w.thickness,
      ...(w.height !== undefined ? { height: w.height } : {}),
      openings: doc.openings
        .filter((o) => o.wallId === w.id)
        .map((o) => ({ id: o.id, offset: o.offset, width: o.width, height: o.height, ...(o.door ? { door: { ...o.door } } : {}) })),
    })),
  );

  const columns = (doc.columns ?? []).map((c) => ({ id: c.id, center: toWorld(...c.center), size: [c.size[0], c.size[1]] as Vec2 }));

  const furniture: FurnitureItem[] = (doc.furniture ?? []).map((f) => {
    const [x, z] = toWorld(f.position[0], f.position[2]);
    return {
      id: f.id,
      kind: f.kind,
      label: f.label ?? KIND_LABELS[f.kind] ?? f.id,
      position: [x, f.position[1], z],
      size: [...f.size],
      ...(f.rotation ? { rotationY: f.rotation } : {}),
      ...(f.group ? { group: f.group } : {}),
    };
  });

  const zones = (doc.zones ?? []).map((z) => {
    const [x0, z0] = toWorld(z.rect[0], z.rect[1]);
    const [x1, z1] = toWorld(z.rect[2], z.rect[3]);
    return { id: z.id, label: z.name, rect: [x0, z0, x1, z1] as [number, number, number, number], labelAt: [q((x0 + x1) / 2), q((z0 + z1) / 2)] as Vec2, material: z.finish };
  });

  const lamps = ceilingLamps(W, D, H);
  const aerialSun: SunConfig = { position: [q(W * 0.4), q(Math.max(W, D) * 1.2 + 5), q(D * 0.9 + 6)], target: [0, 0, 0], color: "#fff6ea", intensity: 2.4, shadow: { bias: -0.0003, normalBias: 0.03 } };
  const interiorSun: SunConfig = { position: sunOutsideWindows(W, D, openings), target: [0, 0, 0], color: "#fff0d9", intensity: 2.8, shadow: { bias: -0.0003, normalBias: 0.03 } };

  const base: SceneConfig = {
    id: doc.id,
    revision: doc.revision,
    title: doc.title ?? doc.id,
    shell: "plan",
    room: { width: W, depth: D, height: H, wallThickness: doc.envelope.wallThickness, baseboardHeight: 0.08, openings },
    furniture,
    partitions,
    columns,
    floorZones: zones.filter((z) => z.material).map((z) => ({ id: z.id, material: z.material!, rect: z.rect })),
    lighting: {
      sun: aerialSun,
      lamps,
      emissiveMaterials: ["ceilingPanel"],
      skyLuminance: 1,
      environment: { intensity: 1, windowLuminance: 4, roomSurfaceIntensityWithLightmap: 0.3 },
    },
    bake: bakeFor(W, D),
    camera: aerialCamera(W, D),
    surfaceMaterials: { floor: "carpetDark", ceiling: "ceiling", north: "officeWall", south: "officeWall", west: "officeWall", east: "officeWall" },
    preloadMaterials: PLAN_MATERIALS,
    environmentPalette: { wall: "#e9e6e0", floor: "#4e4f51", ceiling: "#f2f2f0" },
    annotations: [],
    defaultMode: "aerial",
    plan: {
      zones,
      dimensions: [
        { side: "top", from: -W / 2, to: W / 2, label: `${fmtM(W)} m` },
        { side: "left", from: -D / 2, to: D / 2, label: `${fmtM(D)} m` },
      ],
      callouts: [],
    },
    mapLabels: zones.map((z) => ({ id: z.id, text: z.label, at: z.labelAt })),
  };

  const start = interiorStart(base);
  const modes: Record<"aerial" | "interior", DisplayModeConfig> = {
    aerial: {
      label: "조감도",
      camera: base.camera,
      sun: aerialSun,
      bakeVariant: "open",
      showCeiling: false,
      // 기본 시점이 남쪽(+z)에서 보므로 남쪽 벽을 낮게 절단한다.
      wallCut: { south: 0.45 },
      background: "#eef1f4",
      environmentScale: 1,
      lampScale: 0.3,
      annotations: true,
      minimap: false,
    },
    interior: {
      label: "실내",
      camera: interiorCamera(W, D, H, start),
      sun: interiorSun,
      bakeVariant: "closed",
      showCeiling: true,
      wallCut: {},
      background: "#cfdde8",
      environmentScale: 1,
      lampScale: 1,
      annotations: false,
      minimap: true,
    },
  };
  return { ...base, modes };
}

/* ------------------------------ 계산 규칙 ------------------------------ */

/** 0.1mm 반올림(서버·브라우저 렌더링 값 일치, 결정적 설정) */
const q = (n: number) => Math.round(n * 1e4) / 1e4 + 0;
/** 치수 표기: 5 → "5.0", 3.25 → "3.25" */
const fmtM = (n: number) => (Number.isInteger(Math.round(n * 1000) / 100) ? n.toFixed(1) : n.toFixed(2));

const KIND_LABELS: Partial<Record<FurnitureKind, string>> = {
  sofa: "소파",
  armchair: "암체어",
  coffeeTable: "커피 테이블",
  sideTable: "사이드 테이블",
  tvConsole: "TV 콘솔",
  tv: "TV",
  bookshelf: "책장",
  floorLamp: "스탠드 조명",
  pendantLamp: "펜던트 조명",
  plant: "화분",
  rug: "러그",
  wallArt: "벽 액자",
  conferenceTable: "회의 테이블",
  meetingChair: "회의 의자",
  officeChair: "업무 의자",
  hDesk: "H형 데스크",
  roundMeetingTable: "원형 테이블",
  bench: "벤치",
  lowCabinet: "낮은 수납장",
  pantryCounter: "탕비 카운터",
  unknown: "미분류 가구",
};

const PLAN_MATERIALS: MaterialId[] = [
  "carpetDark", "loungeCarpet", "pantryTile", "backsplashTile", "officeWall", "ceiling", "sectionCap", "deskWhite",
  "conferenceWood", "loungeWood", "doorWood", "doorPaint", "meetingFabric", "benchFabric", "officePartitionGlass",
  "partitionFrame", "windowFrameDark", "glass", "counterTop", "stainless", "applianceBlack", "ceilingPanel",
  "plasticDark", "blackMetal", "screen", "books", "fabric", "leather", "oakLight", "walnut", "canvasWhite",
];

/** 실시간 점광원이므로 개수를 제한한다(최대 12개, 기본 간격 3.5m). */
const MAX_LAMPS = 12;
function ceilingLamps(W: number, D: number, H: number): LampLight[] {
  // 간격 대비 길이가 1.25배를 넘으면 한 줄을 더 둔다(5m 폭 → 2개).
  const count = (len: number, spacing: number) => Math.max(1, Math.ceil(len / spacing - 0.25));
  let spacing = 3.5;
  let nx = count(W, spacing);
  let nz = count(D, spacing);
  while (nx * nz > MAX_LAMPS) {
    spacing *= 1.15;
    nx = count(W, spacing);
    nz = count(D, spacing);
  }
  const out: LampLight[] = [];
  for (let i = 0; i < nx; i++)
    for (let k = 0; k < nz; k++) {
      out.push({ id: `ceiling-light-${out.length + 1}`, position: [q(-W / 2 + ((i + 0.5) * W) / nx), q(H - 0.35), q(-D / 2 + ((k + 0.5) * D) / nz)], color: "#fff3e2", intensity: 5.5, castShadow: false });
    }
  return out;
}

/** 창 면적이 가장 큰 외벽 바깥에서 들어오는 햇빛(창이 없으면 서쪽) */
function sunOutsideWindows(W: number, D: number, openings: WallOpening[]): Vec3 {
  const area: Record<WallId, number> = { north: 0, east: 0, south: 0, west: 0 };
  for (const o of openings) if (o.kind === "window") area[o.wall] += o.width * o.height;
  const wall = (Object.keys(area) as WallId[]).reduce((best, w) => (area[w] > area[best] ? w : best), "west" as WallId);
  const out = 7;
  switch (wall) {
    case "north":
      return [q(W * 0.2), 9, q(-D / 2 - out)];
    case "south":
      return [q(W * 0.2), 9, q(D / 2 + out)];
    case "east":
      return [q(W / 2 + out), 9, q(D * 0.25)];
    default:
      return [q(-W / 2 - out), 9, q(D * 0.25)];
  }
}

/** 면적에 맞춘 베이크 밀도(사무실 18×8m의 텍셀 수 기준, 4~16 texel/m) */
function bakeFor(W: number, D: number): BakeConfig {
  const texelsPerMeter = Math.min(16, Math.max(4, Math.round(10 * Math.sqrt(144 / (W * D)))));
  return {
    texelsPerMeter,
    ambient: [0.17, 0.17, 0.17],
    sky: { color: [0.62, 0.74, 1.0], power: 0.55, grid: 3 },
    sunBounce: { albedo: [0.2, 0.2, 0.21], power: 0.25, grid: 4 },
    lampBounce: { power: 0.05, softening: 1.0 },
    edgeOcclusion: { strength: 0.35, radius: 0.35 },
    furnitureOcclusion: { strength: 0.45, radius: 0.18 },
    partitionOcclusion: { strength: 0.3, radius: 0.14 },
    softening: 0.6,
    openSky: { color: [0.85, 0.9, 1.0], power: 0.22, grid: [6, 3], floorBounce: 0.12 },
  };
}

function aerialCamera(W: number, D: number): CameraConfig {
  const S = Math.max(W, D);
  return {
    fov: 32,
    near: 0.1,
    far: Math.max(200, S * 8),
    minDistance: 3,
    maxDistance: q(Math.max(30, S * 3.9)),
    minPolarAngle: 0,
    maxPolarAngle: 0.47 * Math.PI,
    positionBounds: { min: [q(-W / 2 - S * 2), 1.5, q(-D / 2 - S * 2)], max: [q(W / 2 + S * 2), q(Math.max(12, S * 3.3)), q(D / 2 + S * 2.6)] },
    targetBounds: { min: [-W / 2, 0, -D / 2], max: [W / 2, 2.5, D / 2] },
    defaultView: "overview",
    // fit: 방향만 지정하고 거리는 외곽 전체가 화면에 들어오게 계산한다.
    views: [{ id: "overview", label: "전체", position: [q(-0.2 * S), q(S * 1.1), q(S * 1.15)], target: [0, 0, 0], fit: true }],
    transitionSeconds: 1.2,
  };
}

const INTERIOR_KEYBOARD = { moveSpeed: 1.8, turnSpeed: 75, bodyRadius: 0.2, jumpHeight: 1.0 };
const EYE = 1.6;

function interiorBounds(W: number, D: number, H: number) {
  return {
    positionBounds: { min: [q(-W / 2 + 0.15), 0.3, q(-D / 2 + 0.15)] as Vec3, max: [q(W / 2 - 0.15), q(H - 0.2), q(D / 2 - 0.15)] as Vec3 },
    targetBounds: { min: [q(-W / 2 + 0.05), 0.05, q(-D / 2 + 0.05)] as Vec3, max: [q(W / 2 - 0.05), q(H - 0.1), q(D / 2 - 0.05)] as Vec3 },
  };
}

function interiorCamera(W: number, D: number, H: number, start: ViewPreset): CameraConfig {
  return {
    fov: 60,
    near: 0.05,
    far: Math.max(80, Math.max(W, D) * 4),
    minDistance: 0.3,
    maxDistance: 6,
    minPolarAngle: 0.12 * Math.PI,
    maxPolarAngle: 0.86 * Math.PI,
    ...interiorBounds(W, D, H),
    defaultView: start.id,
    views: [start],
    transitionSeconds: 1.1,
    keyboard: INTERIOR_KEYBOARD,
  };
}

/**
 * 실내 시작 위치: 첫 외벽 문 안쪽 1m(없으면 방 중심)에서 방 중심을 바라본다.
 * 가구·벽·기둥과 겹치면 가장 가까운 빈자리로 옮긴다(보행 충돌과 같은 장애물·몸통 반지름).
 */
export function interiorStart(scene: SceneConfig): ViewPreset {
  const { room } = scene;
  const door = room.openings.find((o) => o.kind === "door");
  const want: Vec2 = door ? planPoint(wallPlanFrame(door.wall, room), door.center, 1.0) : [0, 0];
  const { positionBounds } = interiorBounds(room.width, room.depth, room.height);
  const bounds = { min: [positionBounds.min[0], positionBounds.min[2]] as Vec2, max: [positionBounds.max[0], positionBounds.max[2]] as Vec2 };
  const spot = nearestFreeSpot(activeColliders(buildColliders(scene), EYE), want, INTERIOR_KEYBOARD.bodyRadius, bounds, Math.max(room.width, room.depth)) ?? want;
  const [x, z] = [q(spot[0]), q(spot[1])];
  // 시작점이 방 중심과 거의 같으면 북쪽을 바라본다.
  const target: Vec3 = Math.hypot(x, z) < 0.5 ? [x, 0.9, q(z - 2)] : [0, 0.9, 0];
  return { id: "start", label: door ? "입구" : "시작", position: [x, EYE, z], target };
}
