import { z } from "zod";
import { MATERIALS, type MaterialId } from "@/config/materials";
import type { FurnitureKind } from "@/config/sceneTypes";
import { FLOOR_PLAN_LIMITS as L } from "./limits";

/**
 * FloorPlanDocument v1 — 외부 도면 입력 규격(형식 검증 층).
 *
 * 이 Zod 스키마가 규격의 정본이다. TS 타입은 z.infer로, JSON Schema 파일은 z.toJSONSchema로 생성한다
 * (npm run schema:floor-plan → schemas/floor-plan-document.v1.schema.json).
 *
 * 규칙:
 * - JSON Schema로 표현되지 않는 .refine()·.transform()·.default()를 넣지 않는다. 문서 전체를 봐야 하는
 *   검사(ID 중복·참조·범위·접합 등)는 validate.ts의 문서 검증에 둔다.
 * - 모든 객체는 strictObject로 두어 오타·미지원 필드를 오류로 보고한다.
 *
 * 좌표: 도면 원점은 외곽 실내 마감면의 왼쪽 위, 오른쪽 +u, 아래쪽 +v, 단위 m.
 */

/* ------------------------------ 공용 ------------------------------ */

/** 외곽 벽 예약 ID. 진행 방향: 북 왼쪽→오른쪽, 동 위→아래, 남 오른쪽→왼쪽, 서 아래→위 */
export const ENVELOPE_WALL_IDS = ["north", "east", "south", "west"] as const;
export type EnvelopeWallId = (typeof ENVELOPE_WALL_IDS)[number];

/**
 * 도면에 둘 수 있는 가구 카탈로그 종류. 문은 가구가 아니라 개구부(openings)로 표현하므로 "door"는 제외한다.
 * 장면 타입(FurnitureKind)에 종류가 추가되면 아래 컴파일 검사가 누락을 알린다.
 */
export const CATALOG_FURNITURE_KINDS = [
  "sofa",
  "armchair",
  "coffeeTable",
  "sideTable",
  "tvConsole",
  "tv",
  "bookshelf",
  "floorLamp",
  "pendantLamp",
  "plant",
  "rug",
  "wallArt",
  "conferenceTable",
  "meetingChair",
  "officeChair",
  "hDesk",
  "roundMeetingTable",
  "bench",
  "lowCabinet",
  "pantryCounter",
] as const satisfies readonly FurnitureKind[];
type MissingCatalogKind = Exclude<FurnitureKind, "door" | "unknown" | (typeof CATALOG_FURNITURE_KINDS)[number]>;
// 누락된 종류가 있으면 이 줄이 타입 오류가 된다.
const catalogIsComplete: [MissingCatalogKind] extends [never] ? true : MissingCatalogKind = true;
void catalogIsComplete;

const MATERIAL_IDS = Object.keys(MATERIALS) as [MaterialId, ...MaterialId[]];

const Id = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
  .meta({ description: "영문·숫자로 시작하는 1~64자 ID(영문·숫자·_·.·-). 문서 안의 벽·개구부·기둥·가구·영역 ID는 모두 서로 달라야 한다." });

const JsonPointer = z
  .string()
  .regex(/^(\/([^~/]|~[01])*)+$/)
  .meta({ description: "문서 안의 필드를 가리키는 JSON Pointer(RFC 6901). 예: /ceilingHeight, /walls/0/thickness" });

const Num = z.number();
const Length = z.number().positive();
const Point = z.tuple([Num, Num]).meta({ description: "도면 좌표 [u, v](m)" });
const PixelPoint = z.tuple([Num, Num]).meta({ description: "원본 이미지 픽셀 좌표 [x, y]. 잘라낸 영역이 아니라 원본 전체 기준" });
const PixelRect = z
  .strictObject({ x: z.number().min(0), y: z.number().min(0), width: Length, height: Length })
  .meta({ description: "원본 이미지 픽셀 사각형" });

const ReviewState = z.enum(["unreviewed", "reviewed"]);

/* ------------------------------ 구조 ------------------------------ */

export const EnvelopeSchema = z
  .strictObject({
    width: Length.meta({ description: "실내 마감면 사이 폭(u 방향, m)" }),
    depth: Length.meta({ description: "실내 마감면 사이 깊이(v 방향, m)" }),
    wallThickness: Length.meta({ description: "외벽 두께(m). 실내 치수 바깥쪽에 둔다." }),
  })
  .meta({ description: "직사각형 외곽. 외곽 벽은 north·east·south·west ID로 참조한다." });

export const WallSchema = z
  .strictObject({
    id: Id,
    kind: z.enum(["solid", "glass"]),
    start: Point.meta({ description: "중심선 시작점 [u, v]" }),
    end: Point.meta({ description: "중심선 끝점 [u, v]" }),
    thickness: Length.meta({ description: "벽 두께(m)" }),
    height: Length.optional().meta({ description: "벽 높이(m). 생략하면 ceilingHeight" }),
  })
  .meta({ description: "내부 직선 벽(중심선). 개구부 offset은 start에서 잰다." });

export const DoorLeafSchema = z
  .strictObject({
    leaf: z.enum(["glass", "wood", "paint", "none"]).meta({ description: "문짝 종류. none이면 문틀만" }),
    hinge: z.enum(["start", "end"]).meta({ description: "경첩 위치: 개구부의 벽 진행 방향 시작/끝 쪽" }),
    swing: z.enum(["pos", "neg"]).meta({
      description: "열림 방향: pos = 벽 진행 방향의 왼쪽 법선 쪽(외곽 벽에서는 실내), neg = 반대쪽",
    }),
    angle: z.number().min(0).max(180).meta({ description: "열린 각도(도). 0이면 닫힘" }),
  })
  .meta({ description: "문짝 표현" });

export const OpeningSchema = z
  .strictObject({
    id: Id,
    wallId: Id.meta({ description: "소속 벽 ID(내부 벽 ID 또는 north·east·south·west)" }),
    kind: z.enum(["door", "window", "passage"]).meta({ description: "door = 문, window = 창, passage = 문짝 없는 통로" }),
    offset: Num.meta({ description: "소속 벽 시작점에서 개구부 중심까지 거리(m)" }),
    width: Length,
    height: Length,
    bottom: z.number().min(0).meta({ description: "바닥에서 개구부 하단까지 높이(m). 문·통로는 0" }),
    door: DoorLeafSchema.optional(),
  })
  .meta({ description: "벽 개구부" });

export const ColumnSchema = z
  .strictObject({
    id: Id,
    center: Point,
    size: z.tuple([Length, Length]).meta({ description: "[u 방향 폭, v 방향 깊이](m). 높이는 천장까지" }),
  })
  .meta({ description: "직사각 기둥" });

export const FurnitureSchema = z
  .strictObject({
    id: Id,
    kind: z.enum([...CATALOG_FURNITURE_KINDS, "unknown"]).meta({ description: "카탈로그 종류. 분류하지 못하면 unknown(단순 박스로 표시)" }),
    label: z.string().max(200).optional(),
    position: z.tuple([Num, z.number().min(0), Num]).meta({ description: "바닥 중심 [u, elevation, v](m)" }),
    size: z.tuple([Length, Length, Length]).meta({ description: "[width, height, depth](m)" }),
    rotation: Num.optional().meta({ description: "Y축 회전(도). 0이면 정면이 +v, 양수 회전은 정면을 +u 쪽으로 돌린다" }),
    group: Id.optional().meta({ description: "가구 묶음(테이블과 좌석 등)" }),
  })
  .meta({ description: "가구" });

export const ZoneSchema = z
  .strictObject({
    id: Id,
    name: z.string().min(1).max(100),
    rect: z.tuple([Num, Num, Num, Num]).meta({ description: "[u0, v0, u1, v1](m)" }),
    finish: z.enum(MATERIAL_IDS).optional().meta({ description: "바닥 마감(기본 재질 라이브러리 ID)" }),
  })
  .meta({ description: "직사각 영역" });

/* ------------------------------ 원본·보정·출처 ------------------------------ */

export const SourceSchema = z
  .strictObject({
    kind: z.enum(["image", "json", "manual"]).meta({ description: "image = 이미지에서 추출, json = 외부 JSON, manual = 사람이 직접 입력" }),
    originalUnit: z.enum(["mm", "cm", "m", "in", "ft", "px"]).optional().meta({ description: "원본 표기 단위(정규화 전)" }),
    note: z.string().max(1000).optional(),
    image: z
      .strictObject({
        name: z.string().max(260).optional(),
        mimeType: z.enum(["image/png", "image/jpeg"]),
        width: z.int().positive(),
        height: z.int().positive(),
      })
      .optional(),
    crop: PixelRect.optional().meta({ description: "평면도로 선택한 영역(원본 픽셀)" }),
  })
  .meta({ description: "원본 정보" });

export const CalibrationSchema = z
  .strictObject({
    references: z
      .array(
        z.strictObject({
          label: z.string().max(200).optional(),
          a: PixelPoint,
          b: PixelPoint,
          length: Length.meta({ description: "a–b 구간의 실제 길이(m)" }),
        }),
      )
      .min(1)
      .max(L.counts.calibrationReferences)
      .meta({ description: "실제 길이를 아는 기준 구간. 서로 다른 방향의 두 구간 이상을 권장" }),
    pixelToPlan: z.tuple([Num, Num, Num, Num, Num, Num]).meta({
      description: "원본 픽셀 → 도면 m 아핀 변환 [a, b, c, d, e, f]: u = a·x + c·y + e, v = b·x + d·y + f",
    }),
  })
  .meta({ description: "이미지 배율 보정" });

export const ProvenanceSchema = z
  .strictObject({
    path: JsonPointer,
    origin: z.enum(["source", "user", "default", "derived"]).meta({
      description: "source = 원본에서 추출, user = 사용자 입력, default = 기본값, derived = 계산값",
    }),
    confirmed: z.boolean().meta({ description: "사용자가 확인했는지. AI 신뢰도와 별개" }),
    note: z.string().max(1000).optional(),
    region: PixelRect.optional().meta({ description: "원본 이미지 근거 위치" }),
    confidence: z.number().min(0).max(1).optional().meta({ description: "추출 도구의 신뢰도 점수(참고용, 정확도 아님)" }),
  })
  .meta({ description: "필드별 정보 출처" });

export const StoredIssueSchema = z
  .strictObject({
    id: Id,
    kind: z.enum(["missing", "conflict", "unsupported", "assumption"]).meta({
      description: "missing = 누락, conflict = 치수 충돌, unsupported = 미지원 항목, assumption = 가정값",
    }),
    path: JsonPointer.optional(),
    message: z.string().min(1).max(1000),
    resolved: z.boolean(),
  })
  .meta({ description: "도면에 기록된 확인 항목" });

export const CompletenessSchema = z
  .strictObject({ walls: ReviewState, openings: ReviewState, furniture: ReviewState })
  .meta({ description: "목록별 검토 상태. 빈 목록이 확인된 '없음'인지 미인식인지 구분한다." });

/* ------------------------------ 문서 ------------------------------ */

export const FloorPlanDocumentSchema = z
  .strictObject({
    $schema: z.string().optional().meta({ description: "편집기 검증용 JSON Schema 경로(선택)" }),
    schemaVersion: z.literal(1),
    id: Id,
    revision: z.int().min(1).meta({ description: "수정 버전. 같은 id의 수정본마다 증가" }),
    title: z.string().max(200).optional(),
    unit: z.literal("m").meta({ description: "정규화된 문서의 길이 단위. 원본 단위는 source.originalUnit" }),
    envelope: EnvelopeSchema,
    ceilingHeight: Length.meta({ description: "기본 천장 높이(m)" }),
    walls: z.array(WallSchema).max(L.counts.walls),
    openings: z.array(OpeningSchema).max(L.counts.openings),
    columns: z.array(ColumnSchema).max(L.counts.columns).optional(),
    furniture: z.array(FurnitureSchema).max(L.counts.furniture).optional(),
    zones: z.array(ZoneSchema).max(L.counts.zones).optional(),
    source: SourceSchema.optional(),
    calibration: CalibrationSchema.optional(),
    provenance: z.array(ProvenanceSchema).max(L.counts.provenance).optional(),
    issues: z.array(StoredIssueSchema).max(L.counts.issues).optional(),
    completeness: CompletenessSchema.optional(),
  })
  .meta({
    title: "FloorPlanDocument v1",
    description: "도면 → 3D 변환 입력 문서(단층·직사각형 외곽). 형식 검증 후 문서 검증(ID·참조·범위·접합)을 별도로 수행한다.",
  });

export type FloorPlanDocument = z.infer<typeof FloorPlanDocumentSchema>;
export type FloorPlanWall = z.infer<typeof WallSchema>;
export type FloorPlanOpening = z.infer<typeof OpeningSchema>;
export type FloorPlanColumn = z.infer<typeof ColumnSchema>;
export type FloorPlanFurniture = z.infer<typeof FurnitureSchema>;
export type FloorPlanZone = z.infer<typeof ZoneSchema>;
export type FloorPlanProvenance = z.infer<typeof ProvenanceSchema>;
export type FloorPlanStoredIssue = z.infer<typeof StoredIssueSchema>;

export const FLOOR_PLAN_SCHEMA_FILE = "floor-plan-document.v1.schema.json";

/** JSON Schema 파일 내용(스키마에서 생성). 파일과 이 결과가 다르면 검증 스크립트가 실패한다. */
export function floorPlanJsonSchema(): Record<string, unknown> {
  const json = z.toJSONSchema(FloorPlanDocumentSchema, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>;
  const { $schema, ...rest } = json;
  return { $schema, $id: FLOOR_PLAN_SCHEMA_FILE, ...rest };
}
