import { z } from "zod";
import { resolvePointer, toPointer } from "./jsonPointer";
import { FLOOR_PLAN_LIMITS as L } from "./limits";
import { ENVELOPE_WALL_IDS, FloorPlanDocumentSchema, type FloorPlanDocument, type FloorPlanOpening } from "./schema";

/**
 * FloorPlanDocument 검증 진입점.
 *
 * 1층 형식 검증(Zod 스키마) → 통과한 문서만 2층 문서 검증(이 파일의 순수 함수).
 * 두 층의 결과를 같은 issues 형식(JSON Pointer 경로·심각도·코드·메시지)으로 반환한다.
 * - error: 장면 변환을 하지 않는다.
 * - warning: 생성은 막지 않고 화면에 표시한다(기본값·미확인값·미검토 목록·틈 등).
 *
 * three.js·React에 의존하지 않으므로 브라우저·서버·Node 검증 스크립트에서 함께 쓴다.
 */

export type FloorPlanIssueSeverity = "error" | "warning";

export interface FloorPlanIssue {
  severity: FloorPlanIssueSeverity;
  /** 형식 검증은 "schema.<Zod 코드>", 문서 검증은 "<대상>.<내용>" */
  code: string;
  /** 문제 위치(JSON Pointer). 문서 전체는 "" */
  path: string;
  message: string;
}

export interface FloorPlanValidationResult {
  /** error가 하나도 없으면 true */
  ok: boolean;
  /** 형식 검증을 통과한 문서. 형식 오류가 있으면 null */
  document: FloorPlanDocument | null;
  issues: FloorPlanIssue[];
}

const koreanErrors = z.locales.ko().localeError;

/** 이미 파싱된 값(객체)을 검증한다. */
export function validateFloorPlan(input: unknown): FloorPlanValidationResult {
  const parsed = FloorPlanDocumentSchema.safeParse(input, { error: koreanErrors });
  if (!parsed.success) {
    return {
      ok: false,
      document: null,
      issues: parsed.error.issues.map((i): FloorPlanIssue => {
        const path = toPointer(i.path);
        // 필드 자체가 없으면 Zod는 타입·값 불일치로 보고한다. 누락을 구분해 알린다(예: 단위 누락).
        if ((i.code === "invalid_type" || i.code === "invalid_value") && !resolvePointer(input, path).found) {
          return { severity: "error", code: "schema.required", path, message: `필수 항목 '${String(i.path.at(-1))}'가 없습니다.` };
        }
        return { severity: "error", code: `schema.${i.code}`, path, message: i.message };
      }),
    };
  }
  const issues = checkFloorPlanDocument(parsed.data);
  return { ok: !issues.some((i) => i.severity === "error"), document: parsed.data, issues };
}

/** JSON 문자열(파일 내용)을 크기·구문 확인 후 검증한다. */
export function parseFloorPlanJson(text: string): FloorPlanValidationResult {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > L.maxJsonBytes) {
    return fail("file.tooLarge", `파일 크기 ${fmt(bytes / 1024 / 1024)}MB가 상한 ${fmt(L.maxJsonBytes / 1024 / 1024)}MB를 넘습니다.`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return fail("file.invalidJson", `JSON 구문 오류: ${e instanceof Error ? e.message : String(e)}`);
  }
  return validateFloorPlan(data);
}

function fail(code: string, message: string): FloorPlanValidationResult {
  return { ok: false, document: null, issues: [{ severity: "error", code, path: "", message }] };
}

/* ------------------------------ 기하 보조 ------------------------------ */

type P = readonly [number, number];
const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
const dist = (a: P, b: P) => Math.hypot(b[0] - a[0], b[1] - a[1]);

function pointSegmentDistance(p: P, a: P, b: P): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  if (len2 === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2));
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t));
}

/** 점에서 무한 직선(a→b)까지 거리 */
function pointLineDistance(p: P, a: P, b: P): number {
  const len = dist(a, b);
  return Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / len;
}

/* ------------------------------ 문서 검증 ------------------------------ */

interface WallInfo {
  id: string;
  /** 문서 위치 */
  path: string;
  start: P;
  end: P;
  length: number;
  height: number;
  envelope: boolean;
}

/** 형식 검증을 통과한 문서의 전체 규칙을 검사한다(ID·참조·범위·접합·보정·출처·검토 상태). */
export function checkFloorPlanDocument(doc: FloorPlanDocument): FloorPlanIssue[] {
  const issues: FloorPlanIssue[] = [];
  const error = (code: string, path: string, message: string) => issues.push({ severity: "error", code, path, message });
  const warn = (code: string, path: string, message: string) => issues.push({ severity: "warning", code, path, message });
  const tol = L.tolerance.coord;
  const { width: W, depth: D, wallThickness } = doc.envelope;
  const H = doc.ceilingHeight;
  const inside = (p: P) => p[0] >= -tol && p[0] <= W + tol && p[1] >= -tol && p[1] <= D + tol;

  /* 지원 범위 */
  const range = (code: string, path: string, name: string, value: number, r: { min: number; max: number }) => {
    if (value < r.min || value > r.max) error(code, path, `${name} ${fmt(value)}m가 지원 범위 ${r.min}~${r.max}m를 벗어납니다.`);
  };
  range("range.envelope", "/envelope/width", "외곽 폭", W, L.envelope);
  range("range.envelope", "/envelope/depth", "외곽 깊이", D, L.envelope);
  range("range.envelopeWallThickness", "/envelope/wallThickness", "외벽 두께", wallThickness, L.envelopeWallThickness);
  range("range.ceilingHeight", "/ceilingHeight", "천장 높이", H, L.ceilingHeight);

  /* ID: 벽·개구부·기둥·가구·영역이 하나의 이름 공간을 쓴다. 외곽 벽 ID는 예약 */
  const seen = new Map<string, string>();
  const reserved = new Set<string>(ENVELOPE_WALL_IDS);
  const entities: [string, { id: string }[] | undefined][] = [
    ["walls", doc.walls],
    ["openings", doc.openings],
    ["columns", doc.columns],
    ["furniture", doc.furniture],
    ["zones", doc.zones],
  ];
  for (const [key, list] of entities) {
    list?.forEach((item, i) => {
      const path = `/${key}/${i}/id`;
      if (reserved.has(item.id)) error("id.reserved", path, `'${item.id}'는 외곽 벽 예약 ID입니다. 다른 ID를 사용하세요.`);
      const first = seen.get(item.id);
      if (first) error("id.duplicate", path, `ID '${item.id}'가 ${first}와 중복됩니다.`);
      else seen.set(item.id, path);
    });
  }

  /* 내부 벽 */
  const faces: { name: string; a: P; b: P }[] = [
    { name: "외곽 북쪽 면", a: [0, 0], b: [W, 0] },
    { name: "외곽 동쪽 면", a: [W, 0], b: [W, D] },
    { name: "외곽 남쪽 면", a: [W, D], b: [0, D] },
    { name: "외곽 서쪽 면", a: [0, D], b: [0, 0] },
  ];
  const walls = new Map<string, WallInfo>();
  const envelopeLengths: Record<(typeof ENVELOPE_WALL_IDS)[number], number> = { north: W, east: D, south: W, west: D };
  for (const id of ENVELOPE_WALL_IDS) {
    const f = faces[ENVELOPE_WALL_IDS.indexOf(id)];
    walls.set(id, { id, path: "/envelope", start: f.a, end: f.b, length: envelopeLengths[id], height: H, envelope: true });
  }
  const interior: WallInfo[] = [];
  doc.walls.forEach((w, i) => {
    const path = `/walls/${i}`;
    const length = dist(w.start, w.end);
    range("range.wallThickness", `${path}/thickness`, "벽 두께", w.thickness, L.wallThickness);
    if (w.height !== undefined && w.height > H + tol) {
      error("wall.tallerThanCeiling", `${path}/height`, `벽 높이 ${fmt(w.height)}m가 천장 높이 ${fmt(H)}m보다 높습니다.`);
    }
    const info: WallInfo = { id: w.id, path, start: w.start, end: w.end, length, height: w.height ?? H, envelope: false };
    // 중복·예약 ID는 위에서 보고했다. 개구부 참조는 처음 나온 벽(또는 외곽 벽)으로 해석한다.
    if (!walls.has(w.id)) walls.set(w.id, info);
    let valid = true;
    for (const end of ["start", "end"] as const) {
      if (!inside(w[end])) {
        error("wall.outOfBounds", `${path}/${end}`, `벽 ${end === "start" ? "시작점" : "끝점"} (${w[end].map(fmt).join(", ")})이 외곽(0~${fmt(W)}, 0~${fmt(D)}) 밖에 있습니다.`);
        valid = false;
      }
    }
    if (length <= tol) {
      error("wall.zeroLength", path, "벽의 시작점과 끝점이 같습니다(0길이 벽).");
      return;
    }
    if (length < L.minWallLength) {
      error("wall.tooShort", path, `벽 길이 ${fmt(length)}m가 최소 ${L.minWallLength}m보다 짧습니다.`);
      return;
    }
    const onFace = faces.find((f) => pointLineDistance(w.start, f.a, f.b) <= tol && pointLineDistance(w.end, f.a, f.b) <= tol);
    if (onFace) {
      error("wall.onEnvelope", path, `${onFace.name}과 겹치는 벽입니다. 외벽은 envelope와 north·east·south·west 개구부로 표현합니다.`);
      valid = false;
    }
    if (valid) interior.push(info);
  });

  // 같은 선 위에서 길이가 겹치는 벽(중복 면). 끝점만 닿는 일직선 연결은 허용한다.
  for (let i = 0; i < interior.length; i++) {
    const A = interior[i];
    const dir: P = [(A.end[0] - A.start[0]) / A.length, (A.end[1] - A.start[1]) / A.length];
    for (let j = i + 1; j < interior.length; j++) {
      const B = interior[j];
      if (pointLineDistance(B.start, A.start, A.end) > tol || pointLineDistance(B.end, A.start, A.end) > tol) continue;
      const t0 = (B.start[0] - A.start[0]) * dir[0] + (B.start[1] - A.start[1]) * dir[1];
      const t1 = (B.end[0] - A.start[0]) * dir[0] + (B.end[1] - A.start[1]) * dir[1];
      const overlap = Math.min(A.length, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1));
      if (overlap > tol) error("wall.overlap", B.path, `벽 '${B.id}'가 '${A.id}'와 같은 선 위에서 ${fmt(overlap)}m 겹칩니다.`);
    }
  }

  // 접합 틈: 끝점이 다른 벽·외곽 면에 닿지 않고 nearMiss 이내로 떨어져 있으면 접합 의도로 보고 경고한다.
  for (const w of interior) {
    for (const end of ["start", "end"] as const) {
      const p = w[end];
      let best = { d: Infinity, name: "" };
      for (const f of faces) {
        const d = pointSegmentDistance(p, f.a, f.b);
        if (d < best.d) best = { d, name: f.name };
      }
      for (const o of interior) {
        if (o === w) continue;
        const d = pointSegmentDistance(p, o.start, o.end);
        if (d < best.d) best = { d, name: `벽 '${o.id}'` };
      }
      if (best.d > tol && best.d <= L.tolerance.nearMiss) {
        warn("wall.gap", `${w.path}/${end}`, `벽 '${w.id}'의 ${end === "start" ? "시작점" : "끝점"}이 ${best.name}에서 ${fmt(best.d)}m 떨어져 있습니다. 접합 의도라면 좌표를 맞추세요.`);
      }
    }
  }

  /* 개구부 */
  const byWall = new Map<string, { o: FloorPlanOpening; path: string; u0: number; u1: number }[]>();
  doc.openings.forEach((o, i) => {
    const path = `/openings/${i}`;
    const wall = walls.get(o.wallId);
    if (!wall) {
      error("opening.wallNotFound", `${path}/wallId`, `개구부 '${o.id}'가 참조하는 벽 '${o.wallId}'가 없습니다.`);
      return;
    }
    if (o.width < L.openingWidth.min || o.width > L.openingWidth.max) {
      error("range.openingWidth", `${path}/width`, `개구부 폭 ${fmt(o.width)}m가 지원 범위 ${L.openingWidth.min}~${L.openingWidth.max}m를 벗어납니다.`);
    }
    if (o.kind === "door" || o.kind === "passage") {
      if (o.bottom > tol) error("opening.doorNotOnFloor", `${path}/bottom`, `${o.kind === "door" ? "문" : "통로"}의 하단 높이는 0이어야 합니다(현재 ${fmt(o.bottom)}m).`);
    }
    if (o.kind === "passage" && o.door) error("opening.passageWithDoor", `${path}/door`, "통로(passage)에는 문짝을 둘 수 없습니다. 문짝이 있으면 door로 지정하세요.");
    if (o.kind === "window") {
      if (o.door) error("opening.windowWithDoor", `${path}/door`, "창(window)에는 문짝을 둘 수 없습니다.");
      if (!wall.envelope) error("opening.unsupportedInteriorWindow", path, "내부 벽의 창은 단기 지원 범위가 아닙니다(내부 벽은 바닥에 닿는 문·통로만 지원).");
      else if (o.bottom <= tol) warn("opening.windowOnFloor", `${path}/bottom`, "하단 높이 0인 창입니다. 바닥까지 내려오는 창이 맞는지 확인하세요.");
    }
    const u0 = o.offset - o.width / 2;
    const u1 = o.offset + o.width / 2;
    if (u0 < -tol || u1 > wall.length + tol) {
      error("opening.outOfRange", `${path}/offset`, `개구부 '${o.id}'(${fmt(u0)}~${fmt(u1)}m)가 벽 '${wall.id}' 길이 ${fmt(wall.length)}m를 벗어납니다.`);
    }
    if (o.bottom + o.height > wall.height + tol) {
      error("opening.tooTall", `${path}/height`, `개구부 상단 ${fmt(o.bottom + o.height)}m가 벽 높이 ${fmt(wall.height)}m보다 높습니다.`);
    }
    const list = byWall.get(wall.id) ?? [];
    for (const other of list) {
      const horizontal = Math.min(u1, other.u1) - Math.max(u0, other.u0);
      const vertical = Math.min(o.bottom + o.height, other.o.bottom + other.o.height) - Math.max(o.bottom, other.o.bottom);
      if (horizontal > tol && vertical > tol) error("opening.overlap", path, `개구부 '${o.id}'가 같은 벽의 '${other.o.id}'와 겹칩니다.`);
    }
    list.push({ o, path, u0, u1 });
    byWall.set(wall.id, list);
  });

  /* 기둥 */
  doc.columns?.forEach((c, i) => {
    const [hu, hv] = [c.size[0] / 2, c.size[1] / 2];
    if (!inside([c.center[0] - hu, c.center[1] - hv]) || !inside([c.center[0] + hu, c.center[1] + hv])) {
      error("column.outOfBounds", `/columns/${i}`, `기둥 '${c.id}'가 외곽 밖으로 나갑니다.`);
    }
  });

  /* 가구 */
  doc.furniture?.forEach((f, i) => {
    const path = `/furniture/${i}`;
    const [u, y, v] = f.position;
    const [w, h, d] = f.size;
    if (Math.max(w, h, d) > L.maxFurnitureSize) error("range.furnitureSize", `${path}/size`, `가구 크기가 최대 ${L.maxFurnitureSize}m를 넘습니다.`);
    const t = ((f.rotation ?? 0) * Math.PI) / 180;
    const ax: P = [Math.cos(t), -Math.sin(t)];
    const az: P = [Math.sin(t), Math.cos(t)];
    const corners: P[] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([sx, sz]): P => [u + (sx * w * ax[0]) / 2 + (sz * d * az[0]) / 2, v + (sx * w * ax[1]) / 2 + (sz * d * az[1]) / 2]);
    if (!corners.every(inside)) error("furniture.outOfBounds", `${path}/position`, `가구 '${f.label ?? f.id}'의 바닥 영역이 외곽 밖으로 나갑니다.`);
    if (y + h > H + tol) error("furniture.aboveCeiling", `${path}/position`, `가구 '${f.label ?? f.id}'의 윗면 ${fmt(y + h)}m가 천장 높이 ${fmt(H)}m보다 높습니다.`);
    if (f.kind === "unknown") warn("furniture.unknownKind", `${path}/kind`, `가구 '${f.label ?? f.id}'는 미분류입니다. 단순 박스로 표시합니다.`);
  });

  /* 영역 */
  doc.zones?.forEach((z, i) => {
    const [u0, v0, u1, v1] = z.rect;
    if (u1 - u0 <= tol || v1 - v0 <= tol) error("zone.invalidRect", `/zones/${i}/rect`, `영역 '${z.name}'의 사각형이 잘못되었습니다(u0 < u1, v0 < v1).`);
    else if (!inside([u0, v0]) || !inside([u1, v1])) error("zone.outOfBounds", `/zones/${i}/rect`, `영역 '${z.name}'가 외곽 밖으로 나갑니다.`);
  });

  /* 원본·보정 */
  const src = doc.source;
  if (src?.kind === "image") {
    if (!src.image) error("source.imageMissing", "/source", "이미지 원본의 크기 정보(source.image)가 없습니다.");
    if (!doc.calibration) error("calibration.missing", "/calibration", "이미지에서 추출한 도면은 배율 보정(calibration)이 필요합니다.");
  }
  if (src?.crop && src.image) {
    const c = src.crop;
    if (c.x + c.width > src.image.width + tol || c.y + c.height > src.image.height + tol) {
      error("source.cropOutOfBounds", "/source/crop", "선택 영역이 원본 이미지 밖으로 나갑니다.");
    }
  }
  if (doc.calibration) {
    const [a, b, c, d, e, f] = doc.calibration.pixelToPlan;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-12) {
      error("calibration.degenerate", "/calibration/pixelToPlan", "픽셀 → 도면 변환의 행렬식이 0입니다.");
    } else {
      const toPlan = (p: P): P => [a * p[0] + c * p[1] + e, b * p[0] + d * p[1] + f];
      const dirs: P[] = [];
      doc.calibration.references.forEach((r, i) => {
        const path = `/calibration/references/${i}`;
        const px = dist(r.a, r.b);
        if (px <= tol) {
          error("calibration.zeroLengthReference", path, "기준 구간의 두 점이 같습니다.");
          return;
        }
        dirs.push([(r.b[0] - r.a[0]) / px, (r.b[1] - r.a[1]) / px]);
        const m = dist(toPlan(r.a), toPlan(r.b));
        const rel = Math.abs(m - r.length) / r.length;
        if (rel > L.tolerance.calibrationRelative) {
          warn("calibration.mismatch", path, `기준 구간 실제 길이 ${fmt(r.length)}m와 변환 결과 ${fmt(m)}m가 ${fmt(rel * 100)}% 다릅니다.`);
        }
      });
      const crossChecked = dirs.some((p, i) => dirs.some((q, j) => j > i && Math.abs(p[0] * q[0] + p[1] * q[1]) <= L.tolerance.calibrationAxisCos));
      if (dirs.length > 0 && !crossChecked) {
        warn("calibration.singleAxis", "/calibration/references", "기준 구간이 한 방향뿐입니다. 서로 직교하는 방향의 구간으로 배율을 검산하세요.");
      }
      const sx = Math.hypot(a, b);
      const sy = Math.hypot(c, d);
      if (Math.abs(sx - sy) / Math.max(sx, sy) > L.tolerance.calibrationRelative) {
        warn("calibration.anisotropic", "/calibration/pixelToPlan", `가로·세로 배율이 다릅니다(${fmt(sx * 1000)} / ${fmt(sy * 1000)} mm/px). 왜곡을 늘려 맞춘 것은 아닌지 확인하세요.`);
      }
    }
  }

  /* 정보 출처 */
  const provenancePaths = new Set<string>();
  let unconfirmedSource = 0;
  doc.provenance?.forEach((p, i) => {
    const path = `/provenance/${i}`;
    if (!resolvePointer(doc, p.path).found) warn("provenance.pathNotFound", `${path}/path`, `출처 경로 '${p.path}'가 가리키는 필드가 없습니다.`);
    if (provenancePaths.has(p.path)) warn("provenance.duplicatePath", `${path}/path`, `출처 경로 '${p.path}'가 중복됩니다.`);
    provenancePaths.add(p.path);
    if (p.confirmed) return;
    if (p.origin === "source") unconfirmedSource++;
    else {
      const kind = { default: "기본값", user: "가정값", derived: "계산값" }[p.origin];
      warn("provenance.unconfirmed", p.path, `확인되지 않은 ${kind}입니다${p.note ? `: ${p.note}` : "."}`);
    }
  });
  if (unconfirmedSource > 0) warn("provenance.unconfirmedSource", "/provenance", `원본에서 추출했지만 확인하지 않은 값이 ${unconfirmedSource}개 있습니다.`);

  /* 기록된 확인 항목 */
  const issueIds = new Set<string>();
  const kindLabel = { missing: "누락", conflict: "충돌", unsupported: "미지원", assumption: "가정" } as const;
  doc.issues?.forEach((s, i) => {
    const path = `/issues/${i}`;
    if (issueIds.has(s.id)) warn("issue.duplicateId", `${path}/id`, `확인 항목 ID '${s.id}'가 중복됩니다.`);
    issueIds.add(s.id);
    if (s.path && !resolvePointer(doc, s.path).found) warn("issue.pathNotFound", `${path}/path`, `확인 항목 경로 '${s.path}'가 가리키는 필드가 없습니다.`);
    if (!s.resolved) warn(`document.open.${s.kind}`, s.path ?? path, `[${kindLabel[s.kind]}] ${s.message}`);
  });

  /* 검토 상태 */
  if (!doc.completeness) {
    warn("completeness.missing", "/completeness", "검토 상태가 없습니다. 빈 목록이 확인된 '없음'인지 미인식인지 구분할 수 없습니다.");
  } else {
    const names = { walls: "내부 벽", openings: "개구부", furniture: "가구" } as const;
    for (const key of ["walls", "openings", "furniture"] as const) {
      if (doc.completeness[key] === "unreviewed") {
        warn("completeness.unreviewed", `/completeness/${key}`, `${names[key]} 목록을 아직 검토하지 않았습니다. 누락된 항목이 있을 수 있습니다.`);
      }
    }
  }

  return issues;
}
