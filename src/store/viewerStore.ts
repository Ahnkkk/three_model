import { create } from "zustand";
import { CAMERA, LIGHTING } from "@/config/interior";
import { resolveDisplayMode, sceneKey, type DisplayMode, type SceneConfig } from "@/config/sceneTypes";
import { QUALITY_PRESETS, type QualityLevel } from "@/lib/three/quality";
import type { BackendKind, Capabilities } from "@/lib/three/capabilities";

/**
 * 뷰어 전역 상태.
 * 프레임마다 바뀌는 값(카메라 위치 등)은 여기에 두지 않는다. 통계는 일정 간격으로만 갱신한다.
 *
 * 장면(거실 `/`, 사무실 `/office`)에 들어갈 때 resetForScene()으로 장면 관련 상태를 명시적으로 초기화한다.
 * → 사무실의 시점·밝기·표시 모드·경고가 거실에 남지 않는다.
 * 품질은 렌더러 기능 확인 결과에 따라 진입할 때마다 다시 정한다.
 */

export type ViewerPhase =
  | "detecting" // 브라우저 기능 확인
  | "initializing" // 렌더러 초기화
  | "building" // 텍스처·라이트맵·환경광 생성
  | "compiling" // 셰이더 컴파일
  | "ready"
  | "unsupported"
  | "error";

export type ToneMappingKind = "aces" | "agx" | "neutral";

export interface EffectToggles {
  shadows: boolean;
  lightmap: boolean;
  environment: boolean;
  ao: boolean;
  /** 실험 기능 */
  ssr: boolean;
  lamps: boolean;
}

export interface RenderStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
}

interface ViewerState {
  /** 현재 상태가 속한 장면. 진입 초기화 전에는 null */
  sceneKey: string | null;
  phase: ViewerPhase;
  phaseDetail?: string;
  error?: string;
  capabilities?: Capabilities;
  backend?: BackendKind;
  /** 리소스 준비 시작~완료 시간(ms) */
  prepareMs?: number;
  /** 첫 준비 후 조명 품질 갱신(라이트맵·환경맵 다시 굽기) 중인지. 이전 리소스로 계속 표시한다. */
  refreshing: boolean;

  quality: QualityLevel;
  effects: EffectToggles;
  exposure: number;
  toneMapping: ToneMappingKind;
  environmentIntensity: number;
  lightmapIntensity: number;

  displayMode: DisplayMode;
  annotations: boolean;
  activeView: string;
  /** 같은 시점을 다시 눌러도 이동하도록 하는 카운터 */
  viewRequest: number;
  /** 미니맵 클릭 이동 요청(월드 x, z). seq는 같은 위치를 다시 눌러도 이동하도록 하는 번호 */
  moveRequest: { x: number; z: number; seq: number } | null;
  /** 1인칭 마우스 시점(포인터 잠금) 중인지. 화면을 클릭하면 잠기고(커서 숨김) Esc로 풀린다. */
  pointerLocked: boolean;
  /** 포인터 잠금이 풀린 시각(performance.now). 잠금을 푸는 Esc가 조감도 전환까지 하지 않도록 쓴다. */
  pointerUnlockedAt: number;
  /** 마우스 시점 감도 배율(1 = 기본). 사용자 취향이라 장면을 바꿔도 유지한다. */
  mouseSensitivity: number;

  stats: RenderStats;
  warnings: string[];
  panelOpen: boolean;
  statsOpen: boolean;

  resetForScene: (scene: SceneConfig) => void;
  setPhase: (phase: ViewerPhase, detail?: string) => void;
  setPrepareMs: (ms: number) => void;
  setRefreshing: (refreshing: boolean) => void;
  fail: (error: unknown) => void;
  setCapabilities: (caps: Capabilities) => void;
  setBackend: (backend: BackendKind) => void;
  setQuality: (quality: QualityLevel) => void;
  toggleEffect: (key: keyof EffectToggles, value?: boolean) => void;
  setExposure: (v: number) => void;
  setToneMapping: (v: ToneMappingKind) => void;
  setEnvironmentIntensity: (v: number) => void;
  setLightmapIntensity: (v: number) => void;
  setDisplayMode: (scene: SceneConfig, mode: DisplayMode) => void;
  setAnnotations: (on: boolean) => void;
  goToView: (id: string) => void;
  requestMoveTo: (x: number, z: number) => void;
  setPointerLocked: (locked: boolean) => void;
  setMouseSensitivity: (v: number) => void;
  setStats: (stats: RenderStats) => void;
  addWarning: (message: string) => void;
  dismissWarnings: () => void;
  setPanelOpen: (open: boolean) => void;
  setStatsOpen: (open: boolean) => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

const DEFAULT_EFFECTS: EffectToggles = { shadows: true, lightmap: true, environment: true, ao: QUALITY_PRESETS.high.ao, ssr: false, lamps: true };
/** 이 폭(px) 미만이면 좁은 화면으로 보고 설정·성능 패널을 접어서 시작한다(Tailwind md 경계와 같음). */
const NARROW_SCREEN_PX = 768;
const EMPTY_STATS: RenderStats ={ fps: 0, frameMs: 0, drawCalls: 0, triangles: 0, geometries: 0, textures: 0 };

export const useViewerStore = create<ViewerState>()((set) => ({
  sceneKey: null,
  phase: "detecting",
  refreshing: false,
  quality: "high",
  effects: DEFAULT_EFFECTS,
  exposure: 1,
  toneMapping: "aces",
  environmentIntensity: LIGHTING.environment.intensity,
  lightmapIntensity: 1,
  displayMode: "interior",
  annotations: true,
  activeView: CAMERA.defaultView,
  viewRequest: 0,
  moveRequest: null,
  pointerLocked: false,
  pointerUnlockedAt: 0,
  mouseSensitivity: 1,
  stats: EMPTY_STATS,
  warnings: [],
  panelOpen: true,
  statsOpen: true,

  resetForScene: (scene) => {
    const mode = scene.defaultMode;
    // 좁은 화면(휴대폰 세로 등)에서는 패널이 3D 화면 대부분을 가리므로 접은 상태로 시작한다(버튼으로 펼 수 있다).
    const expanded = !!scene.standalone && !(typeof window !== "undefined" && window.innerWidth < NARROW_SCREEN_PX);
    set({
      sceneKey: sceneKey(scene),
      phase: "detecting",
      phaseDetail: undefined,
      error: undefined,
      capabilities: undefined,
      backend: undefined,
      prepareMs: undefined,
      refreshing: false,
      quality: "high",
      effects: DEFAULT_EFFECTS,
      exposure: 1,
      toneMapping: "aces",
      environmentIntensity: scene.lighting.environment.intensity,
      lightmapIntensity: 1,
      displayMode: mode,
      annotations: true,
      activeView: resolveDisplayMode(scene, mode).camera.defaultView,
      viewRequest: 0,
      moveRequest: null,
      pointerLocked: false,
      stats: EMPTY_STATS,
      warnings: [],
      // 단독 뷰어(거실)는 설정 패널을 펼치고, 2D·3D 비교 화면(사무실·도면)은 접어 둔다.
      panelOpen: expanded,
      statsOpen: expanded,
    });
  },
  setPhase: (phase, phaseDetail) => set({ phase, phaseDetail }),
  setPrepareMs: (prepareMs) => set({ prepareMs }),
  setRefreshing: (refreshing) => set({ refreshing }),
  fail: (error) => set({ phase: "error", error: errorMessage(error) }),
  setCapabilities: (capabilities) => set({ capabilities }),
  setBackend: (backend) => set({ backend }),
  setQuality: (quality) => set((s) => ({ quality, effects: { ...s.effects, ao: QUALITY_PRESETS[quality].ao } })),
  toggleEffect: (key, value) => set((s) => ({ effects: { ...s.effects, [key]: value ?? !s.effects[key] } })),
  setExposure: (exposure) => set({ exposure }),
  setToneMapping: (toneMapping) => set({ toneMapping }),
  setEnvironmentIntensity: (environmentIntensity) => set({ environmentIntensity }),
  setLightmapIntensity: (lightmapIntensity) => set({ lightmapIntensity }),
  setDisplayMode: (scene, displayMode) =>
    set((s) => ({
      displayMode,
      activeView: resolveDisplayMode(scene, displayMode).camera.defaultView,
      viewRequest: s.viewRequest + 1,
    })),
  setAnnotations: (annotations) => set({ annotations }),
  goToView: (activeView) => set((s) => ({ activeView, viewRequest: s.viewRequest + 1 })),
  requestMoveTo: (x, z) => set((s) => ({ moveRequest: { x, z, seq: (s.moveRequest?.seq ?? 0) + 1 } })),
  setPointerLocked: (locked) =>
    set((s) => (locked === s.pointerLocked ? s : { pointerLocked: locked, pointerUnlockedAt: locked ? s.pointerUnlockedAt : performance.now() })),
  setMouseSensitivity: (mouseSensitivity) => set({ mouseSensitivity }),
  setStats: (stats) => set({ stats }),
  addWarning: (message) => set((s) => (s.warnings.includes(message) ? s : { warnings: [...s.warnings, message] })),
  dismissWarnings: () => set({ warnings: [] }),
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  setStatsOpen: (statsOpen) => set({ statsOpen }),
}));
