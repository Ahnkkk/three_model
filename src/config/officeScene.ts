import {
  buildOfficeAnnotations,
  buildOfficeColumns,
  buildOfficeFurniture,
  buildOfficeLamps,
  buildOfficeOpenings,
  buildOfficePartitions,
  buildOfficePlanView,
  buildOfficeZones,
} from "@/lib/three/officeLayout";
import type { MaterialId } from "./materials";
import { OFFICE_PLAN } from "./officePlan";
import type { CameraConfig, DisplayModeConfig, SceneConfig, SunConfig } from "./sceneTypes";

/**
 * 사무실 장면 설정.
 *
 * - 조감도(aerial, 기본): 천장 없음, 남쪽 벽을 낮게 절단한 모형 표현. 위에서 들어오는 밝은 프레젠테이션 조명.
 * - 실내(interior): 천장·전체 벽 표시, 서쪽 창으로 들어오는 햇빛과 천장등.
 * 두 모드는 벽·천장 조건이 다르므로 라이트맵(open / closed)과 환경맵을 따로 만든다.
 */

const AERIAL_CAMERA: CameraConfig = {
  fov: 32,
  near: 0.1,
  far: 200,
  minDistance: 3,
  maxDistance: 70,
  minPolarAngle: 0,
  maxPolarAngle: 0.47 * Math.PI,
  positionBounds: { min: [-45, 1.5, -45], max: [45, 60, 55] },
  targetBounds: { min: [-9, 0, -4], max: [9, 2.5, 4] },
  defaultView: "overview",
  views: [
    { id: "overview", label: "전체", position: [-4.2, 20, 21], target: [0.2, 0, 0.4], fit: true },
    { id: "large-meeting", label: "대회의실", position: [-8.2, 9.5, 7.5], target: [-6.5, 0.3, 0] },
    { id: "h-desk", label: "H형 데스크", position: [-0.5, 10, 6.5], target: [0.65, 0.3, -1.6] },
    { id: "small-meeting", label: "소회의실", position: [-3.6, 6.5, 8.6], target: [-2.2, 0.3, 2.0] },
    { id: "open-meeting", label: "오픈 미팅", position: [1.0, 6.5, 9.0], target: [1.9, 0.3, 2.0] },
    { id: "lounge", label: "라운지·탕비", position: [5.4, 10.5, 3.6], target: [7.5, 0.2, -0.5] },
  ],
  transitionSeconds: 1.2,
};

const INTERIOR_CAMERA: CameraConfig = {
  fov: 60,
  near: 0.05,
  far: 80,
  minDistance: 0.3,
  maxDistance: 6,
  minPolarAngle: 0.12 * Math.PI,
  maxPolarAngle: 0.86 * Math.PI,
  positionBounds: { min: [-8.85, 0.3, -3.85], max: [8.85, 2.6, 3.85] },
  targetBounds: { min: [-8.95, 0.05, -3.95], max: [8.95, 2.7, 3.95] },
  defaultView: "entrance",
  views: [
    { id: "entrance", label: "입구", position: [4.9, 1.6, 3.4], target: [0, 0.9, -1.5] },
    { id: "large-meeting", label: "대회의실", position: [-4.7, 1.65, 3.3], target: [-7.5, 0.8, -2.5] },
    { id: "work", label: "업무공간", position: [4.7, 1.6, -0.4], target: [-1, 0.8, -2.8] },
    { id: "small-meeting", label: "소회의실", position: [-3.5, 1.6, 3.5], target: [-1.4, 0.8, 0.8] },
    { id: "lounge", label: "라운지", position: [6.4, 1.55, -0.7], target: [8, 0.6, -2.8] },
    { id: "pantry", label: "탕비", position: [6.5, 1.6, 3.6], target: [7.8, 1.0, 0.9] },
  ],
  transitionSeconds: 1.1,
  // 실내 모드는 3D 전체 화면이므로 키보드로 걸어 다닐 수 있게 한다(18m 폭 기준 보행 속도보다 약간 빠르게).
  keyboard: { moveSpeed: 1.8, turnSpeed: 75, bodyRadius: 0.2, jumpHeight: 1.0 },
};

const AERIAL_SUN: SunConfig = {
  position: [7, 22, 13],
  target: [0, 0, 0],
  color: "#fff6ea",
  intensity: 2.4,
  shadow: { bias: -0.0003, normalBias: 0.03 },
};

const INTERIOR_SUN: SunConfig = {
  position: [-16, 9, 4],
  target: [0, 0, 0],
  color: "#fff0d9",
  intensity: 2.8,
  shadow: { bias: -0.0003, normalBias: 0.03 },
};

const MODES: Record<"aerial" | "interior", DisplayModeConfig> = {
  aerial: {
    label: "조감도",
    camera: AERIAL_CAMERA,
    sun: AERIAL_SUN,
    bakeVariant: "open",
    showCeiling: false,
    wallCut: { south: 0.45 },
    background: "#eef1f4",
    environmentScale: 1,
    lampScale: 0.3,
    annotations: true,
    minimap: false,
  },
  interior: {
    label: "실내",
    camera: INTERIOR_CAMERA,
    sun: INTERIOR_SUN,
    bakeVariant: "closed",
    showCeiling: true,
    wallCut: {},
    background: "#cfdde8",
    environmentScale: 1,
    lampScale: 1,
    annotations: false,
    // 실내는 3D 전체 화면으로 걸어 다니므로 현재 위치를 미니맵으로 보여 준다.
    minimap: true,
  },
};

const OFFICE_MATERIALS: MaterialId[] = [
  "carpetDark", "loungeCarpet", "pantryTile", "backsplashTile", "officeWall", "ceiling", "sectionCap", "deskWhite",
  "conferenceWood", "loungeWood", "doorWood", "doorPaint", "meetingFabric", "benchFabric", "officePartitionGlass",
  "partitionFrame", "windowFrameDark", "glass", "counterTop", "stainless", "applianceBlack", "ceilingPanel",
  "plasticDark", "blackMetal", "screen", "books", "fabric", "leather", "oakLight", "walnut",
];

export const OFFICE_SCENE: SceneConfig = {
  id: "office",
  title: "사무실",
  shell: "plan",
  room: {
    width: OFFICE_PLAN.width,
    depth: OFFICE_PLAN.depth,
    height: OFFICE_PLAN.height,
    wallThickness: OFFICE_PLAN.wallThickness,
    baseboardHeight: 0.08,
    openings: buildOfficeOpenings(),
  },
  furniture: buildOfficeFurniture(),
  partitions: buildOfficePartitions(),
  columns: buildOfficeColumns(),
  floorZones: buildOfficeZones()
    .filter((z) => z.floor)
    .map((z) => ({ id: z.id, material: z.floor!, rect: z.rect })),
  lighting: {
    sun: AERIAL_SUN,
    lamps: buildOfficeLamps(),
    emissiveMaterials: ["ceilingPanel"],
    skyLuminance: 1,
    environment: { intensity: 1, windowLuminance: 4, roomSurfaceIntensityWithLightmap: 0.3 },
  },
  bake: {
    // 면적이 거실의 약 4.8배이므로 텍셀 밀도를 낮춘 초안 품질로 시작한다.
    texelsPerMeter: 10,
    ambient: [0.17, 0.17, 0.17],
    sky: { color: [0.62, 0.74, 1.0], power: 0.55, grid: 3 },
    sunBounce: { albedo: [0.2, 0.2, 0.21], power: 0.25, grid: 4 },
    lampBounce: { power: 0.05, softening: 1.0 },
    edgeOcclusion: { strength: 0.35, radius: 0.35 },
    furnitureOcclusion: { strength: 0.45, radius: 0.18 },
    partitionOcclusion: { strength: 0.3, radius: 0.14 },
    softening: 0.6,
    openSky: { color: [0.85, 0.9, 1.0], power: 0.22, grid: [6, 3], floorBounce: 0.12 },
  },
  camera: AERIAL_CAMERA,
  surfaceMaterials: { floor: "carpetDark", ceiling: "ceiling", north: "officeWall", south: "officeWall", west: "officeWall", east: "officeWall" },
  preloadMaterials: OFFICE_MATERIALS,
  environmentPalette: { wall: "#e9e6e0", floor: "#4e4f51", ceiling: "#f2f2f0" },
  annotations: buildOfficeAnnotations(),
  defaultMode: "aerial",
  modes: MODES,
  plan: buildOfficePlanView(),
  mapLabels: buildOfficeZones()
    .filter((z) => z.labelAt && !z.assumption)
    .map((z) => ({ id: z.id, text: z.label, at: z.labelAt! })),
};
