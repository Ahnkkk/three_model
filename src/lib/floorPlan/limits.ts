/**
 * FloorPlanDocument v1 지원 범위.
 *
 * 모든 값은 단기 계획 S1의 초기 제안값이며 실측·평가 결과가 아니다. S5 평가 후 조정한다.
 * - 개수 상한·양수 조건처럼 형식에 가까운 값은 Zod 스키마(schema.ts)가 검사해 JSON Schema에도 남긴다.
 * - 치수 범위·허용 오차는 문서 검증(validate.ts)이 검사해 한국어 설명과 함께 보고한다.
 */
export const FLOOR_PLAN_LIMITS = {
  /** 도면 JSON 파일 최대 크기(byte) */
  maxJsonBytes: 2 * 1024 * 1024,
  /** S3 이미지 입력용(아직 사용하지 않음) */
  image: { maxBytes: 20 * 1024 * 1024, maxPixels: 40_000_000 },

  /** 외곽 실내 폭·깊이(m) */
  envelope: { min: 1, max: 60 },
  /** 외벽 두께(m) */
  envelopeWallThickness: { min: 0.05, max: 1 },
  /** 천장 높이(m) */
  ceilingHeight: { min: 2, max: 6 },
  /** 내부 벽 두께(m) */
  wallThickness: { min: 0.02, max: 0.6 },
  /** 내부 벽 최소 길이(m). 이보다 짧으면 0길이에 가까운 잘못된 벽으로 본다. */
  minWallLength: 0.05,
  /** 개구부 폭(m) */
  openingWidth: { min: 0.3, max: 6 },
  /** 가구 한 변의 최대 크기(m) */
  maxFurnitureSize: 20,

  /** 배열 항목 수 상한(스키마) */
  counts: {
    walls: 300,
    openings: 500,
    columns: 200,
    furniture: 2000,
    zones: 200,
    provenance: 20_000,
    issues: 2000,
    calibrationReferences: 20,
  },

  tolerance: {
    /** 같은 점·같은 선으로 보는 좌표 오차(m) */
    coord: 0.001,
    /** 벽 끝점이 다른 벽·외곽에서 이 거리 이내로 떨어져 있으면 접합 의도로 보고 틈을 경고한다(m) */
    nearMiss: 0.05,
    /** 기준 구간의 실제 길이와 변환 결과의 허용 상대 오차 */
    calibrationRelative: 0.01,
    /** 두 기준 구간을 서로 다른 방향으로 볼 최소 각도의 코사인(|cos| 이하면 다른 방향, 45°) */
    calibrationAxisCos: Math.SQRT1_2,
  },
} as const;
