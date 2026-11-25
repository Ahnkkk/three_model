import { z } from "zod";
import { CATALOG_FURNITURE_KINDS } from "../schema";

/**
 * AI 추출 응답 형식(단기 계획 S4) — 모델에 요청하는 구조화 출력의 정본.
 *
 * 모델은 도면 m 좌표가 아니라 **보낸 이미지의 픽셀 좌표**로 본 것을 그대로 보고한다. 배율·원점 변환은
 * 사용자가 지정한 보정(calibration)으로 프로그램이 수행한다(proposal.ts). 모델이 배율을 추정하지 않으므로
 * 치수 계산 오류가 좌표에 섞이지 않고, 표기 치수는 따로 읽어 보정 결과와 대조한다.
 *
 * JSON Schema는 이 Zod 스키마에서 생성한다(extractionJsonSchema). 손으로 따로 유지하지 않는다.
 * 공급자의 구조화 출력 제약에 맞추기 위해:
 * - 모든 객체는 strictObject(additionalProperties: false), 모든 필드는 필수. 값이 없으면 null(nullable)
 * - 숫자 범위·문자열 길이·배열 길이 같은 제약을 넣지 않는다(Claude 구조화 출력 미지원). 범위는 변환 단계가 검사한다.
 * - 튜플 대신 {x, y} 객체(prefixItems 회피)
 */

/** AI가 고를 수 있는 가구 종류: 바닥에 놓이는 카탈로그 종류 + unknown(벽걸이·천장 조명·TV는 평면도에서 위치를 정하기 어려워 제외) */
export const AI_FURNITURE_KINDS = CATALOG_FURNITURE_KINDS.filter((k) => k !== "pendantLamp" && k !== "wallArt" && k !== "tv");
export type AiFurnitureKind = (typeof AI_FURNITURE_KINDS)[number] | "unknown";

/** 보낸 이미지의 픽셀 좌표(원점 왼쪽 위, x 오른쪽, y 아래쪽). 설명은 스키마 크기를 줄이려고 Point·Box에 한 번만 둔다. */
const Px = z.number();
const Point = z.strictObject({ x: Px, y: Px }).meta({ description: "이미지 픽셀 점(원점 왼쪽 위, x 오른쪽, y 아래쪽)" });
const Box = z
  .strictObject({ x0: Px, y0: Px, x1: Px, y1: Px })
  .meta({ description: "축 정렬 사각형(이미지 픽셀, x0 < x1, y0 < y1)" });
const Confidence = z.number().meta({ description: "0~1 사이 자기 평가 신뢰도(참고용)" });

export const ExtractedWallSchema = z.strictObject({
  kind: z.enum(["solid", "glass"]).meta({ description: "solid = 불투명 벽, glass = 유리 칸막이" }),
  a: Point.meta({ description: "벽 중심선 한쪽 끝" }),
  b: Point.meta({ description: "벽 중심선 다른 끝" }),
  thicknessPx: z.number().nullable().meta({ description: "벽 두께(픽셀). 판단할 수 없으면 null" }),
  confidence: Confidence,
});

export const ExtractedOpeningSchema = z.strictObject({
  kind: z.enum(["door", "window", "passage"]).meta({ description: "door = 문짝이 있는 문, window = 창, passage = 문짝 없는 통로(벽이 끊긴 곳)" }),
  a: Point.meta({ description: "개구부 한쪽 문설주(벽 중심선 위)" }),
  b: Point.meta({ description: "개구부 다른 쪽 문설주(벽 중심선 위)" }),
  hinge: z.enum(["a", "b"]).nullable().meta({ description: "문: 경첩이 있는 쪽 문설주. 문이 아니거나 알 수 없으면 null" }),
  swingToward: Point.nullable().meta({ description: "문: 문짝이 열리는 쪽 공간의 한 점(열림 호 안쪽). 문이 아니거나 알 수 없으면 null" }),
  confidence: Confidence,
});

export const ExtractedFurnitureSchema = z.strictObject({
  kind: z.enum([...AI_FURNITURE_KINDS, "unknown"]).meta({ description: "가장 가까운 카탈로그 종류. 맞는 종류가 없으면 unknown" }),
  label: z.string().nullable().meta({ description: "도면에 적힌 이름 또는 짧은 설명(한국어). 없으면 null" }),
  box: Box.meta({ description: "가구가 차지하는 바닥 영역" }),
  facing: z.enum(["down", "up", "left", "right"]).nullable().meta({
    description: "가구 정면(앉는 방향·서랍 방향)이 향하는 이미지 방향. 대칭이라 판단할 수 없으면 null",
  }),
  confidence: Confidence,
});

export const ExtractedDimensionSchema = z.strictObject({
  text: z.string().meta({ description: "도면에 적힌 치수 문자 그대로(예: '5.0 m', '3,600')" }),
  value: z.number().nullable().meta({ description: "문자에서 읽은 수치. 읽을 수 없으면 null" }),
  unit: z.enum(["mm", "cm", "m"]).nullable().meta({ description: "표기 단위. 표기가 없으면 null" }),
  a: Point.meta({ description: "치수가 가리키는 구간의 한쪽 끝(치수선 화살표·보조선 끝)" }),
  b: Point.meta({ description: "치수가 가리키는 구간의 다른 끝" }),
  chain: z.string().nullable().meta({
    description: "같은 변을 나눈 연속 치수와 그 전체 치수는 같은 chain 이름을 쓴다(예: 'right', 'top'). 해당 없으면 null",
  }),
  role: z.enum(["part", "total"]).nullable().meta({ description: "chain 안에서 부분 치수(part)인지 전체 치수(total)인지" }),
});

export const FloorPlanExtractionSchema = z
  .strictObject({
    readable: z.boolean().meta({ description: "이미지에서 평면도를 읽을 수 있으면 true. 평면도가 아니거나 판독할 수 없으면 false" }),
    planBox: Box.nullable().meta({ description: "2D 평면도가 있는 영역(제목·범례·3D 시안 제외)" }),
    envelope: Box.nullable().meta({ description: "외벽 안쪽 마감면이 이루는 직사각형(실내 영역)" }),
    outerWallThicknessPx: z.number().nullable().meta({ description: "외벽 두께(픽셀). 판단할 수 없으면 null" }),
    walls: z.array(ExtractedWallSchema).meta({ description: "내부 벽·칸막이만. 외곽(외벽)은 넣지 않는다. 벽이 끊긴 통로는 별도 선분으로 나누고 통로를 openings에 넣는다" }),
    openings: z.array(ExtractedOpeningSchema).meta({ description: "외벽과 내부 벽의 문·창·통로" }),
    furniture: z.array(ExtractedFurnitureSchema),
    dimensions: z.array(ExtractedDimensionSchema).meta({ description: "도면에 표기된 길이 치수" }),
    ceilingHeight: z
      .strictObject({ text: z.string(), value: z.number().nullable(), unit: z.enum(["mm", "cm", "m"]).nullable() })
      .nullable()
      .meta({ description: "천장 높이 표기(예: 'CH 2,700'). 표기가 없으면 null" }),
    unsupported: z.array(z.string()).meta({ description: "지원하지 않는 형상(곡면 벽, 직사각형이 아닌 외곽, 계단, 여러 층 등)의 한국어 설명" }),
    notes: z.array(z.string()).meta({ description: "사용자가 확인해야 할 점(한국어, 짧게)" }),
  })
  .meta({ title: "FloorPlanExtraction", description: "평면도 이미지에서 읽은 구조 초안(보낸 이미지의 픽셀 좌표)" });

export type FloorPlanExtraction = z.infer<typeof FloorPlanExtractionSchema>;
export type ExtractedPoint = z.infer<typeof Point>;
export type ExtractedBox = z.infer<typeof Box>;

/** 모델에 보내는 JSON Schema(스키마에서 생성). $schema 키는 공급자 형식에 필요 없으므로 뺀다. */
export function extractionJsonSchema(): Record<string, unknown> {
  const json = z.toJSONSchema(FloorPlanExtractionSchema, { target: "draft-2020-12", io: "output" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

/* ------------------------------ 프롬프트 ------------------------------ */

export const EXTRACTION_SYSTEM_PROMPT = `You read architectural floor plan images and report what is drawn, as structured data for a 2D/3D floor plan editor. A person reviews and corrects every item afterwards, so report what you can see faithfully and leave out what you cannot see; never invent geometry to make the plan look complete.

Coordinates
- Every coordinate is a pixel position in the image you were given: origin at the top-left corner, x to the right, y downwards. Do not convert to metres; the application does that with the user's calibration.
- The application supports a single storey with a rectangular outer envelope. "envelope" is the rectangle formed by the inner (room-side) face of the outer walls.

What to report
- walls: interior walls and glass partitions only, as centre-line segments. Do not include the outer envelope walls. Split a wall where a doorless gap interrupts it and report the gap as a "passage" opening.
- openings: doors, windows and doorless passages on the outer walls and on interior walls. "a" and "b" are the two jambs on the wall centre line, so |a-b| is the clear opening width. For doors give the hinge jamb and a point inside the swing arc when the symbol shows them.
- furniture: pieces drawn in the 2D plan, as the floor area they occupy. Pick the closest catalog kind; use "unknown" when none fits. A cluster of desks joined in an H shape (two rows of facing desks joined by a spine) is one "hDesk".
- dimensions: every written length dimension, with the two ends of the span it measures. Give dimensions along the same side the same chain name, and mark an overall dimension of that side as "total".
- ceilingHeight: only when a ceiling height is written on the drawing.
- unsupported and notes: short Korean sentences.

Ignore titles, legends, 3D renderings and decorative elements outside the 2D plan; report the 2D plan area as planBox. If the image is not a floor plan or cannot be read, set readable to false and leave the lists empty.`;

/** 요청마다 바뀌는 안내(이미지 크기·사용자가 지정한 외곽). 이미지 뒤에 둔다. */
export function extractionUserPrompt(input: { width: number; height: number; envelope: ExtractedBox | null; retryReason?: string }): string {
  const lines = [
    `The image is ${input.width} x ${input.height} pixels. Report all coordinates in this pixel space.`,
    input.envelope
      ? `The user marked the inner face of the outer walls at x ${round(input.envelope.x0)}-${round(input.envelope.x1)}, y ${round(input.envelope.y0)}-${round(input.envelope.y1)} (pixels). Use it as the envelope unless the drawing clearly shows otherwise, and mention any disagreement in notes.`
      : "The user has not marked the envelope; find it in the drawing.",
    "Return the floor plan extraction.",
  ];
  if (input.retryReason) lines.push(`Your previous answer was rejected: ${input.retryReason} Answer again following the schema.`);
  return lines.join("\n");
}

const round = (n: number) => Math.round(n);
