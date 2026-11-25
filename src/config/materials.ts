/**
 * PBR 재질 정의.
 *
 * 프로토타입에서는 텍스처를 런타임에 절차적으로 생성한다(외부 에셋 불필요).
 * 실제 텍스처(Poly Haven·ambientCG 등)로 교체할 때는 `texture` 대신 `maps`에 파일 경로를 지정하는 방식으로 확장한다.
 * - 색상(color) 텍스처: sRGB
 * - roughness / normal 등 데이터 텍스처: Linear(NoColorSpace)
 */

export type ProceduralTextureKind =
  | "woodPlanks"
  | "woodGrain"
  | "plaster"
  | "fabric"
  | "marble"
  | "rug"
  | "ceramic"
  | "leaf"
  | "carpet"
  | "tiles";

export interface MaterialDef {
  color: string;
  roughness: number;
  metalness: number;
  /** 절차적 텍스처 */
  texture?: {
    kind: ProceduralTextureKind;
    /**
     * 텍스처 1장이 덮는 실제 크기(m). 지오메트리 UV가 미터 단위이므로 repeat = 1 / metersPerTile.
     * 0이면 반복 없이 0..1 UV에 맞춘다(러그처럼 전체 문양이 하나인 경우).
     */
    metersPerTile: number;
    seed?: number;
  };
  emissive?: string;
  emissiveIntensity?: number;
  transparent?: boolean;
  opacity?: number;
  /** 열린 회전체(전등갓 등)처럼 안쪽 면이 보이는 경우 */
  doubleSided?: boolean;
}

export const MATERIALS = {
  floorWood: { color: "#ffffff", roughness: 0.62, metalness: 0, texture: { kind: "woodPlanks", metersPerTile: 2.4, seed: 1 } },
  wallPlaster: { color: "#f1ebe2", roughness: 0.92, metalness: 0, texture: { kind: "plaster", metersPerTile: 1.5, seed: 2 } },
  ceiling: { color: "#f7f5f1", roughness: 0.95, metalness: 0, texture: { kind: "plaster", metersPerTile: 2, seed: 5 } },
  baseboard: { color: "#efeae3", roughness: 0.55, metalness: 0 },
  walnut: { color: "#6e4a33", roughness: 0.55, metalness: 0, texture: { kind: "woodGrain", metersPerTile: 0.9, seed: 3 } },
  oakLight: { color: "#c9a57c", roughness: 0.6, metalness: 0, texture: { kind: "woodGrain", metersPerTile: 0.9, seed: 9 } },
  fabric: { color: "#9a9c94", roughness: 0.96, metalness: 0, texture: { kind: "fabric", metersPerTile: 0.25, seed: 4 } },
  leather: { color: "#8b5a3c", roughness: 0.62, metalness: 0, texture: { kind: "fabric", metersPerTile: 0.4, seed: 8 } },
  marble: { color: "#ffffff", roughness: 0.9, metalness: 0, texture: { kind: "marble", metersPerTile: 1.2, seed: 6 } },
  blackMetal: { color: "#1e1e1f", roughness: 0.38, metalness: 1 },
  brass: { color: "#c9a25f", roughness: 0.3, metalness: 1, doubleSided: true },
  rug: { color: "#ffffff", roughness: 0.98, metalness: 0, texture: { kind: "rug", metersPerTile: 0, seed: 10 } },
  ceramic: { color: "#e8e2d8", roughness: 0.35, metalness: 0, texture: { kind: "ceramic", metersPerTile: 0.5, seed: 12 } },
  soil: { color: "#3b2a1e", roughness: 1, metalness: 0 },
  leaf: { color: "#ffffff", roughness: 0.6, metalness: 0, texture: { kind: "leaf", metersPerTile: 0.3, seed: 13 } },
  screen: { color: "#060708", roughness: 0.12, metalness: 0.2 },
  plasticDark: { color: "#141414", roughness: 0.45, metalness: 0 },
  lampShade: { color: "#f3e6cf", roughness: 0.85, metalness: 0, emissive: "#ffd9a0", emissiveIntensity: 1.6, doubleSided: true },
  bulb: { color: "#fff6e5", roughness: 0.3, metalness: 0, emissive: "#ffe2b0", emissiveIntensity: 6 },
  glass: { color: "#dfeef5", roughness: 0.05, metalness: 0, transparent: true, opacity: 0.12 },
  windowFrame: { color: "#f2f0ec", roughness: 0.5, metalness: 0 },
  doorPaint: { color: "#e9e4dc", roughness: 0.5, metalness: 0 },
  canvasWhite: { color: "#f5f3ee", roughness: 0.9, metalness: 0 },
  books: { color: "#ffffff", roughness: 0.75, metalness: 0 },

  /* ---------------- 사무실(기존 거실 재질 값은 변경하지 않고 추가만 한다) ---------------- */
  carpetDark: { color: "#5d5e61", roughness: 1, metalness: 0, texture: { kind: "carpet", metersPerTile: 1.2, seed: 21 } },
  loungeCarpet: { color: "#6a5e55", roughness: 1, metalness: 0, texture: { kind: "carpet", metersPerTile: 1.2, seed: 22 } },
  pantryTile: { color: "#f1eee8", roughness: 0.55, metalness: 0, texture: { kind: "tiles", metersPerTile: 1.2, seed: 23 } },
  backsplashTile: { color: "#f7f6f3", roughness: 0.35, metalness: 0, texture: { kind: "tiles", metersPerTile: 0.6, seed: 24 } },
  officeWall: { color: "#f3efe8", roughness: 0.9, metalness: 0, texture: { kind: "plaster", metersPerTile: 2, seed: 25 } },
  /** 조감도 단면(벽 상단·바닥 테두리) */
  sectionCap: { color: "#e3a35c", roughness: 0.7, metalness: 0 },
  deskWhite: { color: "#f3f3f1", roughness: 0.42, metalness: 0 },
  conferenceWood: { color: "#e39a3e", roughness: 0.55, metalness: 0, texture: { kind: "woodGrain", metersPerTile: 1.4, seed: 26 } },
  loungeWood: { color: "#d39a52", roughness: 0.55, metalness: 0, texture: { kind: "woodGrain", metersPerTile: 0.9, seed: 27 } },
  doorWood: { color: "#d8954c", roughness: 0.55, metalness: 0, texture: { kind: "woodGrain", metersPerTile: 1.2, seed: 28 } },
  meetingFabric: { color: "#77706a", roughness: 0.95, metalness: 0, texture: { kind: "fabric", metersPerTile: 0.25, seed: 29 } },
  benchFabric: { color: "#aaa59e", roughness: 0.96, metalness: 0, texture: { kind: "fabric", metersPerTile: 0.3, seed: 30 } },
  officePartitionGlass: { color: "#8fd6c3", roughness: 0.06, metalness: 0, transparent: true, opacity: 0.3, doubleSided: true },
  partitionFrame: { color: "#e6e9eb", roughness: 0.35, metalness: 0.5 },
  windowFrameDark: { color: "#2f3033", roughness: 0.5, metalness: 0.2 },
  counterTop: { color: "#e2e0dc", roughness: 0.28, metalness: 0 },
  stainless: { color: "#c8ccd0", roughness: 0.28, metalness: 1 },
  applianceBlack: { color: "#1c1c1e", roughness: 0.32, metalness: 0.1 },
  ceilingPanel: { color: "#f6f6f4", roughness: 0.6, metalness: 0, emissive: "#fff3dd", emissiveIntensity: 2.2 },
} satisfies Record<string, MaterialDef>;

export type MaterialId = keyof typeof MATERIALS;

/** 라이트맵이 개별로 연결되는 방 표면 */
export type RoomSurfaceId = "floor" | "ceiling" | "north" | "south" | "west" | "east";
