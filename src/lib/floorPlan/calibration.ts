import { createBlankDocument, mm, setProvenance, type Pt } from "./editor";
import { FLOOR_PLAN_LIMITS } from "./limits";
import type { FloorPlanDocument } from "./schema";

/**
 * 이미지 배율 보정(정면 스캔 전제: 회전·원근 없음).
 *
 * 1) 실제 길이를 아는 기준 구간(픽셀 두 점 + m)으로 배율(m/px)을 구한다. 여러 구간이면 평균을 쓰고 차이는 문서 검증이 경고한다.
 * 2) 외곽 실내 마감면 사각형(픽셀)의 왼쪽 위를 도면 원점으로 삼아 픽셀 → 도면 변환을 만든다.
 *    u = s·x − s·x0, v = s·y − s·y0  →  pixelToPlan = [s, 0, 0, s, −s·x0, −s·y0]
 * 이미지 왜곡을 숨기려고 가로·세로 배율을 따로 맞추지 않는다.
 */

export interface ImageInfo {
  name?: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
}

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReferenceInput {
  label?: string;
  a: Pt;
  b: Pt;
  /** 실제 길이(m) */
  length: number;
}

export interface CalibrationInput {
  image: ImageInfo;
  crop?: PixelRect;
  references: ReferenceInput[];
  /** 외곽 실내 마감면 사각형(원본 픽셀) */
  envelope: PixelRect;
}

export interface CalibrationResult {
  /** m/px */
  scale: number;
  pixelToPlan: [number, number, number, number, number, number];
  width: number;
  depth: number;
}

/** 이미지 파일 검증(형식·용량·픽셀 수). 문제가 없으면 null */
export function checkImageFile(file: { type: string; size: number }, pixels?: { width: number; height: number }): string | null {
  if (file.type !== "image/png" && file.type !== "image/jpeg") return "PNG 또는 JPG 이미지만 열 수 있습니다.";
  if (file.size > FLOOR_PLAN_LIMITS.image.maxBytes) return `이미지 용량이 상한 ${FLOOR_PLAN_LIMITS.image.maxBytes / 1024 / 1024}MB를 넘습니다.`;
  if (pixels && pixels.width * pixels.height > FLOOR_PLAN_LIMITS.image.maxPixels) {
    return `이미지 픽셀 수(${pixels.width}×${pixels.height})가 상한 ${FLOOR_PLAN_LIMITS.image.maxPixels / 1_000_000}MP를 넘습니다.`;
  }
  return null;
}

export const normalizeRect = (a: Pt, b: Pt): PixelRect => ({
  x: Math.min(a[0], b[0]),
  y: Math.min(a[1], b[1]),
  width: Math.abs(b[0] - a[0]),
  height: Math.abs(b[1] - a[1]),
});

/** 기준 구간과 외곽 사각형으로 배율·변환·외곽 크기를 구한다. 계산할 수 없으면 이유를 반환한다. */
export function computeCalibration(input: Pick<CalibrationInput, "references" | "envelope">): CalibrationResult | { error: string } {
  const scales = input.references
    .filter((r) => r.length > 0)
    .map((r) => ({ px: Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]), m: r.length }))
    .filter((r) => r.px > 1)
    .map((r) => r.m / r.px);
  if (!scales.length) return { error: "실제 길이를 입력한 기준 구간이 하나 이상 필요합니다." };
  const { envelope: e } = input;
  if (e.width < 2 || e.height < 2) return { error: "외곽(실내 마감면) 사각형을 지정하세요." };
  const scale = scales.reduce((a, b) => a + b, 0) / scales.length;
  return {
    scale,
    pixelToPlan: [scale, 0, 0, scale, -e.x * scale, -e.y * scale],
    width: mm(e.width * scale),
    depth: mm(e.height * scale),
  };
}

/** 픽셀 → 도면(m) */
export function pixelToPlan(m: CalibrationResult["pixelToPlan"], p: Pt): Pt {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

/**
 * 보정 결과를 문서에 반영한다. doc이 없으면 새 문서를 만든다.
 * 외곽 크기는 기준 구간에서 계산한 값(derived, 미확인)으로 기록하고, 원본·선택 영역·기준 구간·변환을 저장한다.
 * 기존 벽·개구부의 도면 좌표(m)는 그대로 둔다.
 */
export function applyCalibration(doc: FloorPlanDocument | null, input: CalibrationInput, newId: string): FloorPlanDocument | { error: string } {
  const result = computeCalibration(input);
  if ("error" in result) return result;
  const base = doc ?? createBlankDocument({ id: newId, title: input.image.name?.replace(/\.[^.]+$/, ""), width: result.width, depth: result.depth });
  let next: FloorPlanDocument = {
    ...base,
    envelope: { ...base.envelope, width: result.width, depth: result.depth },
    source: {
      ...(base.source?.kind === "image" ? base.source : {}),
      kind: "image",
      image: { ...(input.image.name ? { name: input.image.name } : {}), mimeType: input.image.mimeType, width: input.image.width, height: input.image.height },
      ...(input.crop && input.crop.width > 1 && input.crop.height > 1 ? { crop: roundRect(input.crop) } : {}),
    },
    calibration: {
      references: input.references
        .filter((r) => r.length > 0)
        .map((r) => ({ ...(r.label ? { label: r.label } : {}), a: roundPt(r.a), b: roundPt(r.b), length: r.length })),
      pixelToPlan: result.pixelToPlan.map((n) => Math.round(n * 1e9) / 1e9 + 0) as CalibrationResult["pixelToPlan"],
    },
  };
  const note = `기준 구간에서 환산(${(1 / result.scale).toFixed(1)} px/m)`;
  next = setProvenance(next, { path: "/envelope/width", origin: "derived", confirmed: false, note });
  next = setProvenance(next, { path: "/envelope/depth", origin: "derived", confirmed: false, note });
  return next;
}

/** 다시 연결한 원본 이미지가 문서의 원본과 같은 크기인지 */
export function imageMatchesSource(doc: FloorPlanDocument, image: { width: number; height: number }): boolean {
  const src = doc.source?.image;
  return !src || (src.width === image.width && src.height === image.height);
}

const roundPt = (p: Pt): Pt => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10];
const roundRect = (r: PixelRect): PixelRect => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
