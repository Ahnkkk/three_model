/**
 * 품질 프리셋. 측정 결과에 따라 값을 조정한다.
 * WebGL 2 대체 실행 시에는 기본 프리셋을 한 단계 낮추고 실험 효과(SSR)를 끈다.
 */
export type QualityLevel = "low" | "medium" | "high";

export interface QualityPreset {
  label: string;
  /** devicePixelRatio 범위 */
  dpr: [number, number];
  shadowMapSize: number;
  /** AO 기본 사용 여부 */
  ao: boolean;
  /** AO 내부 해상도 배율 */
  aoResolutionScale: number;
  aoSamples: number;
  /** SSR 내부 해상도 배율 */
  ssrResolutionScale: number;
}

export const QUALITY_PRESETS: Record<QualityLevel, QualityPreset> = {
  low: { label: "낮음", dpr: [1, 1], shadowMapSize: 1024, ao: false, aoResolutionScale: 0.5, aoSamples: 8, ssrResolutionScale: 0.5 },
  medium: { label: "보통", dpr: [1, 1.5], shadowMapSize: 2048, ao: true, aoResolutionScale: 0.5, aoSamples: 12, ssrResolutionScale: 0.5 },
  high: { label: "높음", dpr: [1, 2], shadowMapSize: 4096, ao: true, aoResolutionScale: 1, aoSamples: 16, ssrResolutionScale: 0.75 },
};

export function defaultQualityFor(backend: "webgpu" | "webgl2"): QualityLevel {
  return backend === "webgpu" ? "high" : "medium";
}
