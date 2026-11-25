import { pixelToPlan, type PixelRect } from "../calibration";
import {
  clampOffset,
  EDITOR_DEFAULTS,
  mm,
  nextId,
  projectOnWall,
  setCompleteness,
  setProvenance,
  wallGeoms,
  wallLength,
  type Pt,
  type WallGeom,
} from "../editor";
import { FLOOR_PLAN_LIMITS as L } from "../limits";
import type { FloorPlanDocument, FloorPlanFurniture, FloorPlanOpening, FloorPlanStoredIssue, FloorPlanWall } from "../schema";
import type { AiFurnitureKind, ExtractedBox, ExtractedPoint, FloorPlanExtraction } from "./extraction";
import { sentToOriginal, type AiProviderId, type ImageFrame } from "./protocol";

/**
 * AI 추출 결과 → 도면 제안 → 현재 문서와의 차이 → 선택 항목 적용(단기 계획 S4). 모두 순수 함수다.
 *
 * 1) buildProposal: 모델 좌표(보낸 이미지 픽셀)를 원본 픽셀 → 도면 m로 바꾸고, 벽 끝점을 외곽·다른 벽에 맞춘다.
 *    표기 치수는 보정으로 잰 길이와, 연속 치수의 합계는 전체 치수와 대조해 충돌을 확인 항목으로 만든다.
 * 2) planChanges: 제안 항목을 현재 문서와 짝지어 추가·변경·동일로 나눈다. 사용자가 입력했거나 확인한 값은
 *    보호 대상으로 표시하고 기본 선택에서 뺀다(재분석이 확정값을 조용히 덮어쓰지 않도록).
 *    기존 항목을 AI가 찾지 못해도 지우지 않는다.
 * 3) applyProposal: 선택한 변경만 적용한다. 적용한 값의 출처는 source(원본에서 추출)·미확인으로 기록하고
 *    원본 이미지 근거 위치(region)와 신뢰도를 함께 남긴다. 높이 등 도면에 없는 값은 기본값(default)으로 기록한다.
 */

export interface ProposalMeta {
  provider: AiProviderId;
  model: string;
  /** ISO 시각 */
  at: string;
}

export interface ProposedWall {
  ref: string;
  kind: FloorPlanWall["kind"];
  start: Pt;
  end: Pt;
  thickness: number;
  /** 두께를 도면에서 읽었는지(아니면 종류별 기본값) */
  thicknessRead: boolean;
  region: PixelRect;
  confidence: number;
}

export interface ProposedOpening {
  ref: string;
  kind: FloorPlanOpening["kind"];
  /** 문설주 두 점(도면 m) */
  a: Pt;
  b: Pt;
  hinge: "a" | "b" | null;
  swingToward: Pt | null;
  region: PixelRect;
  confidence: number;
}

export interface ProposedFurniture {
  ref: string;
  kind: AiFurnitureKind;
  label: string | null;
  center: Pt;
  /** [width, height, depth] (m). 높이는 종류별 기본값 */
  size: [number, number, number];
  rotation: number;
  region: PixelRect;
  confidence: number;
}

export interface DimensionCheck {
  text: string;
  /** 표기 값(m). 읽지 못했으면 null */
  stated: number | null;
  /** 보정으로 잰 구간 길이(m) */
  measured: number;
  /** 치수가 가리킨 구간의 양 끝(도면 m). 치수선 위의 점이라 벽에서 떨어져 있을 수 있다. */
  a: Pt;
  b: Pt;
  /** 단위 표기가 없어 잰 길이에 가장 가까운 단위로 해석했는지 */
  unitAssumed: boolean;
  status: "ok" | "conflict" | "unread";
  chain: string | null;
  role: "part" | "total" | null;
}

export interface ProposedIssue {
  key: string;
  kind: FloorPlanStoredIssue["kind"];
  message: string;
  path?: string;
}

export interface AiProposal {
  meta: ProposalMeta;
  walls: ProposedWall[];
  openings: ProposedOpening[];
  furniture: ProposedFurniture[];
  ceilingHeight: { value: number; text: string } | null;
  /** AI가 읽은 외곽 크기(m, 보정 기준). 비교용 */
  envelope: { width: number; depth: number } | null;
  dimensions: DimensionCheck[];
  issues: ProposedIssue[];
  notes: string[];
  /** 변환 단계에서 버린 항목과 이유 */
  dropped: string[];
}

/** 종류별 기본 높이(m). 평면도에는 높이가 없으므로 기본값으로 기록한다(실측값 아님). */
export const AI_FURNITURE_HEIGHTS: Record<AiFurnitureKind, number> = {
  sofa: 0.8,
  armchair: 0.8,
  coffeeTable: 0.42,
  sideTable: 0.55,
  tvConsole: 0.5,
  bookshelf: 1.8,
  floorLamp: 1.6,
  plant: 1.2,
  rug: 0.01,
  conferenceTable: 0.74,
  meetingChair: 0.85,
  officeChair: 0.95,
  hDesk: 0.74,
  roundMeetingTable: 0.74,
  bench: 0.45,
  lowCabinet: 0.75,
  pantryCounter: 0.9,
  unknown: 0.75,
};

/** 변환 허용값(m). 초기 제안값이며 S5 평가 후 조정한다. */
export const PROPOSAL_TOLERANCE = {
  /** 이 거리 안의 끝점·외곽은 같은 점·선으로 맞춘다 */
  snap: 0.15,
  /** 이 각도(도) 안의 벽은 수평·수직으로 편다 */
  orthoDegrees: 3,
  /** 이보다 짧은 벽은 버린다 */
  minWall: 0.2,
  /** 외곽선과 이 거리 안에서 나란한 벽은 외벽을 다시 그린 것으로 보고 버린다 */
  envelopeOverlap: 0.2,
  /** 기존 벽과 끝점 거리가 이 안이면 같은 벽으로 본다 */
  wallMatch: 0.3,
  /** 개구부 문설주가 벽 중심선에서 이 거리 안이면 그 벽의 개구부로 본다(외벽은 마감면에서 두께 절반 밖이 중심선) */
  openingHost: 0.3,
  /** 기존 가구와 중심 거리가 이 안이면 같은 가구로 본다 */
  furnitureMatch: 0.6,
  /** 표기 치수와 잰 길이의 허용 차이: max(절대, 상대 × 표기값) */
  dimensionAbs: 0.1,
  dimensionRel: 0.03,
  /** 연속 치수 합계와 전체 치수의 허용 차이 */
  chainAbs: 0.05,
  /** AI 외곽과 보정 외곽의 허용 차이: max(절대, 상대) */
  envelopeAbs: 0.1,
  envelopeRel: 0.02,
} as const;
const T = PROPOSAL_TOLERANCE;

/* ------------------------------ 1. 제안 만들기 ------------------------------ */

export function buildProposal(doc: FloorPlanDocument, extraction: FloorPlanExtraction, frame: ImageFrame, meta: ProposalMeta): AiProposal | { error: string } {
  const cal = doc.calibration;
  if (!cal) return { error: "문서에 이미지 보정 정보가 없습니다. 이미지 보정을 먼저 적용하세요." };
  const m = cal.pixelToPlan;
  const { width: W, depth: D } = doc.envelope;
  const toOriginal = (p: ExtractedPoint) => sentToOriginal(frame, p);
  const toPlan = (p: ExtractedPoint): Pt => pixelToPlan(m, toOriginal(p));
  /** 보낸 이미지 1px의 길이(m). 보정은 등방 배율이다. */
  const metrePerSentPx = Math.hypot(m[0], m[1]) * (frame.crop.width / frame.width);
  const region = (pts: ExtractedPoint[], pad = 4): PixelRect => {
    const o = pts.map(toOriginal);
    const xs = o.map((p) => p[0]);
    const ys = o.map((p) => p[1]);
    const x = Math.max(0, Math.floor(Math.min(...xs) - pad));
    const y = Math.max(0, Math.floor(Math.min(...ys) - pad));
    return { x, y, width: Math.max(1, Math.ceil(Math.max(...xs) + pad) - x), height: Math.max(1, Math.ceil(Math.max(...ys) + pad) - y) };
  };
  const boxPoints = (b: ExtractedBox): ExtractedPoint[] => [
    { x: b.x0, y: b.y0 },
    { x: b.x1, y: b.y1 },
  ];
  const confidence = (c: number) => (Number.isFinite(c) ? Math.min(1, Math.max(0, Math.round(c * 100) / 100)) : 0);
  const clampU = (u: number) => Math.min(W, Math.max(0, u));
  const clampV = (v: number) => Math.min(D, Math.max(0, v));
  const fmt = (n: number) => `${Math.round(n * 100) / 100}`;

  const dropped: string[] = [];
  const issues: ProposedIssue[] = [];

  /* 벽 */
  const rawWalls = extraction.walls.map((w, i) => ({
    ref: `w${i + 1}`,
    kind: w.kind,
    start: [clampU(toPlan(w.a)[0]), clampV(toPlan(w.a)[1])] as Pt,
    end: [clampU(toPlan(w.b)[0]), clampV(toPlan(w.b)[1])] as Pt,
    thicknessPx: w.thicknessPx,
    region: region([w.a, w.b]),
    confidence: confidence(w.confidence),
  }));
  let walls = rawWalls.filter((w) => {
    if (wallLength(w) < T.minWall) {
      dropped.push(`벽 ${w.ref}: 길이 ${fmt(wallLength(w))}m — 너무 짧음`);
      return false;
    }
    if (alongEnvelope(w.start, w.end, W, D)) {
      dropped.push(`벽 ${w.ref}: 외곽 벽과 겹침`);
      return false;
    }
    return true;
  });
  walls = tidyWalls(walls, W, D);
  const proposedWalls: ProposedWall[] = walls.flatMap((w) => {
    if (wallLength(w) < T.minWall) {
      dropped.push(`벽 ${w.ref}: 맞춘 뒤 길이 ${fmt(wallLength(w))}m — 너무 짧음`);
      return [];
    }
    const t = w.thicknessPx !== null && w.thicknessPx > 0 ? mm(w.thicknessPx * metrePerSentPx) : null;
    const thicknessRead = t !== null && t >= 0.05 && t <= 0.4;
    return [
      {
        ref: w.ref,
        kind: w.kind,
        start: [mm(w.start[0]), mm(w.start[1])] as Pt,
        end: [mm(w.end[0]), mm(w.end[1])] as Pt,
        thickness: thicknessRead ? t : EDITOR_DEFAULTS.wallThickness[w.kind],
        thicknessRead,
        region: w.region,
        confidence: w.confidence,
      },
    ];
  });

  /* 개구부 */
  const proposedOpenings: ProposedOpening[] = extraction.openings.flatMap((o, i) => {
    const ref = `o${i + 1}`;
    const a = toPlan(o.a);
    const b = toPlan(o.b);
    const width = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (width < L.openingWidth.min * 0.8 || width > L.openingWidth.max) {
      dropped.push(`개구부 ${ref}: 폭 ${fmt(width)}m — 지원 범위(${L.openingWidth.min}~${L.openingWidth.max}m) 밖`);
      return [];
    }
    return [
      {
        ref,
        kind: o.kind,
        a: [mm(a[0]), mm(a[1])] as Pt,
        b: [mm(b[0]), mm(b[1])] as Pt,
        hinge: o.kind === "door" ? o.hinge : null,
        swingToward: o.kind === "door" && o.swingToward ? (toPlan(o.swingToward).map(mm) as Pt) : null,
        region: region([o.a, o.b, ...(o.swingToward ? [o.swingToward] : [])]),
        confidence: confidence(o.confidence),
      },
    ];
  });

  /* 가구 */
  const proposedFurniture: ProposedFurniture[] = extraction.furniture.flatMap((f, i) => {
    const ref = `f${i + 1}`;
    const p0 = toPlan({ x: Math.min(f.box.x0, f.box.x1), y: Math.min(f.box.y0, f.box.y1) });
    const p1 = toPlan({ x: Math.max(f.box.x0, f.box.x1), y: Math.max(f.box.y0, f.box.y1) });
    // 벽에 붙여 그린 가구가 벽 두께 안으로 조금 들어가면 벽 밖으로 밀고(보행·관통 검사와 맞춤), 외곽 밖 부분은 잘라낸다.
    const [n0, m0, n1, m1] = nudgeFromWalls(
      [Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1])],
      proposedWalls,
    );
    const u0 = Math.max(0, n0);
    const u1 = Math.min(W, n1);
    const v0 = Math.max(0, m0);
    const v1 = Math.min(D, m1);
    const su = u1 - u0;
    const sv = v1 - v0;
    const name = f.label ?? f.kind;
    if (su < 0.15 || sv < 0.15) {
      dropped.push(`가구 ${ref}(${name}): 외곽 안 크기 ${fmt(su)} × ${fmt(sv)}m — 너무 작거나 외곽 밖`);
      return [];
    }
    if (su > L.maxFurnitureSize || sv > L.maxFurnitureSize) {
      dropped.push(`가구 ${ref}(${name}): 크기가 상한 ${L.maxFurnitureSize}m를 넘음`);
      return [];
    }
    // 정면 방향: 회전 0 = +v(이미지 아래), 양의 회전은 정면을 +u(오른쪽)로 돌린다.
    const rotation = f.facing === "right" ? 90 : f.facing === "up" ? 180 : f.facing === "left" ? -90 : 0;
    const sideways = rotation === 90 || rotation === -90;
    const width = mm(sideways ? sv : su);
    const depth = mm(sideways ? su : sv);
    return [
      {
        ref,
        kind: f.kind,
        label: f.label,
        center: [mm((u0 + u1) / 2), mm((v0 + v1) / 2)] as Pt,
        size: [width, AI_FURNITURE_HEIGHTS[f.kind], depth] as [number, number, number],
        rotation,
        region: region(boxPoints(f.box)),
        confidence: confidence(f.confidence),
      },
    ];
  });

  /* 외곽 대조 */
  let envelope: AiProposal["envelope"] = null;
  if (extraction.envelope) {
    const e = extraction.envelope;
    const p0 = toPlan({ x: Math.min(e.x0, e.x1), y: Math.min(e.y0, e.y1) });
    const p1 = toPlan({ x: Math.max(e.x0, e.x1), y: Math.max(e.y0, e.y1) });
    envelope = { width: mm(p1[0] - p0[0]), depth: mm(p1[1] - p0[1]) };
    const tolW = Math.max(T.envelopeAbs, T.envelopeRel * W);
    const tolD = Math.max(T.envelopeAbs, T.envelopeRel * D);
    const shifted = Math.abs(p0[0]) > tolW || Math.abs(p0[1]) > tolD;
    if (Math.abs(envelope.width - W) > tolW || Math.abs(envelope.depth - D) > tolD || shifted) {
      issues.push({
        key: "envelope",
        kind: "conflict",
        path: "/envelope/width",
        message: `AI가 읽은 외곽(${fmt(envelope.width)} × ${fmt(envelope.depth)}m${shifted ? `, 원점 ${fmt(p0[0])}, ${fmt(p0[1])}m` : ""})이 보정한 외곽(${fmt(W)} × ${fmt(D)}m)과 다릅니다. 보정의 외곽 사각형과 기준 구간을 확인하세요.`,
      });
    }
  }

  /* 치수 대조 */
  const dimensions: DimensionCheck[] = extraction.dimensions.map((d) => {
    const pa = toPlan(d.a);
    const pb = toPlan(d.b);
    const measured = mm(Math.hypot(pb[0] - pa[0], pb[1] - pa[1]));
    const span = { a: [mm(pa[0]), mm(pa[1])] as Pt, b: [mm(pb[0]), mm(pb[1])] as Pt };
    const read = toMetres(d.value, d.unit, measured);
    if (!read) return { text: d.text, stated: null, measured, ...span, unitAssumed: false, status: "unread", chain: d.chain, role: d.role };
    const tol = Math.max(T.dimensionAbs, T.dimensionRel * read.metres);
    const status = Math.abs(read.metres - measured) > tol ? "conflict" : "ok";
    return { text: d.text, stated: mm(read.metres), measured, ...span, unitAssumed: read.assumed, status, chain: d.chain, role: d.role };
  });
  dimensions.forEach((d, i) => {
    if (d.status === "conflict" && d.stated !== null) {
      issues.push({
        key: `dimension:${i}:${d.text}`,
        kind: "conflict",
        message: `치수 '${d.text}': 표기 ${fmt(d.stated)}m, 보정 기준으로 잰 길이 ${fmt(d.measured)}m. 기준 구간 또는 표기를 확인하세요.`,
      });
    }
  });
  const chains = new Map<string, DimensionCheck[]>();
  for (const d of dimensions) if (d.chain && d.stated !== null) chains.set(d.chain, [...(chains.get(d.chain) ?? []), d]);
  for (const [name, list] of chains) {
    const parts = list.filter((d) => d.role === "part");
    const totals = list.filter((d) => d.role === "total");
    if (parts.length < 2 || !totals.length) continue;
    const sum = mm(parts.reduce((s, d) => s + (d.stated ?? 0), 0));
    for (const total of totals) {
      if (total.stated !== null && Math.abs(sum - total.stated) > T.chainAbs) {
        issues.push({
          key: `chain:${name}:${total.text}`,
          kind: "conflict",
          message: `치수 합계 불일치(${name}): ${parts.map((d) => d.text).join(" + ")} = ${fmt(sum)}m, 전체 치수 '${total.text}' = ${fmt(total.stated)}m (차이 ${fmt(Math.abs(sum - total.stated))}m).`,
        });
      }
    }
  }

  /* 천장 높이 */
  let ceilingHeight: AiProposal["ceilingHeight"] = null;
  if (extraction.ceilingHeight) {
    const c = extraction.ceilingHeight;
    const read = toMetres(c.value, c.unit, EDITOR_DEFAULTS.ceilingHeight);
    if (read && read.metres >= L.ceilingHeight.min && read.metres <= L.ceilingHeight.max) ceilingHeight = { value: mm(read.metres), text: c.text };
    else issues.push({ key: "ceiling:unread", kind: "conflict", path: "/ceilingHeight", message: `천장 높이 표기 '${c.text}'를 해석하지 못했습니다(지원 범위 ${L.ceilingHeight.min}~${L.ceilingHeight.max}m).` });
  } else {
    const p = doc.provenance?.find((x) => x.path === "/ceilingHeight");
    if (!p || p.origin === "default") {
      issues.push({ key: "ceiling:missing", kind: "missing", path: "/ceilingHeight", message: `도면에서 천장 높이 표기를 찾지 못했습니다. 현재 값 ${doc.ceilingHeight}m를 확인하세요.` });
    }
  }

  extraction.unsupported.forEach((text, i) => issues.push({ key: `unsupported:${i}:${text}`, kind: "unsupported", message: `지원하지 않는 형상: ${text}` }));

  return {
    meta,
    walls: proposedWalls,
    openings: proposedOpenings,
    furniture: proposedFurniture,
    ceilingHeight,
    envelope,
    dimensions,
    issues,
    notes: extraction.notes.filter((n) => n.trim()).slice(0, 50),
    dropped,
  };
}

/** 표기 값 → m. 단위가 없으면 잰 길이(근사값)에 가장 가까운 단위로 해석한다. */
function toMetres(value: number | null, unit: "mm" | "cm" | "m" | null, approx: number): { metres: number; assumed: boolean } | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  const factor = { mm: 0.001, cm: 0.01, m: 1 } as const;
  if (unit) return { metres: value * factor[unit], assumed: false };
  const best = (["mm", "cm", "m"] as const)
    .map((u) => ({ u, metres: value * factor[u] }))
    .sort((p, q) => Math.abs(Math.log(p.metres / approx)) - Math.abs(Math.log(q.metres / approx)))[0];
  return { metres: best.metres, assumed: true };
}

/**
 * 수평·수직 벽의 몸체(두께)와 조금(최대 FURNITURE_NUDGE) 겹치는 가구 영역을 가구 중심이 있는 쪽으로 밀어낸 영역 [u0, v0, u1, v1].
 * 크게 겹치면 해석이 잘못되었을 수 있으므로 그대로 두고 배치 검사가 알리게 한다.
 */
function nudgeFromWalls(rect: [number, number, number, number], walls: { start: Pt; end: Pt; thickness: number }[]): [number, number, number, number] {
  let [u0, v0, u1, v1] = rect;
  for (const w of walls) {
    const h = w.thickness / 2 + 0.005;
    if (w.start[0] === w.end[0]) {
      const u = w.start[0];
      const lo = Math.min(w.start[1], w.end[1]);
      const hi = Math.max(w.start[1], w.end[1]);
      if (v1 <= lo || v0 >= hi || u1 <= u - h || u0 >= u + h) continue;
      const shift = (u0 + u1) / 2 < u ? u - h - u1 : u + h - u0;
      if (Math.abs(shift) <= FURNITURE_NUDGE) [u0, u1] = [u0 + shift, u1 + shift];
    } else if (w.start[1] === w.end[1]) {
      const v = w.start[1];
      const lo = Math.min(w.start[0], w.end[0]);
      const hi = Math.max(w.start[0], w.end[0]);
      if (u1 <= lo || u0 >= hi || v1 <= v - h || v0 >= v + h) continue;
      const shift = (v0 + v1) / 2 < v ? v - h - v1 : v + h - v0;
      if (Math.abs(shift) <= FURNITURE_NUDGE) [v0, v1] = [v0 + shift, v1 + shift];
    }
  }
  return [u0, v0, u1, v1];
}
const FURNITURE_NUDGE = 0.15;

/** 선분이 외곽선 하나를 따라 놓였는지 */
function alongEnvelope(a: Pt, b: Pt, W: number, D: number): boolean {
  const e = T.envelopeOverlap;
  return (
    (Math.abs(a[1]) < e && Math.abs(b[1]) < e) ||
    (Math.abs(a[1] - D) < e && Math.abs(b[1] - D) < e) ||
    (Math.abs(a[0]) < e && Math.abs(b[0]) < e) ||
    (Math.abs(a[0] - W) < e && Math.abs(b[0] - W) < e)
  );
}

type TidyWall = { ref: string; start: Pt; end: Pt };

const withEnd = <Wl extends TidyWall>(w: Wl, k: "start" | "end", p: Pt): Wl => (k === "start" ? { ...w, start: p } : { ...w, end: p });

/**
 * 벽 끝점 정리: 수평·수직에 가까운 벽을 펴고, 가까운 끝점끼리 합치고, 다른 벽 몸체 가까이 끝난 끝점을 그 벽에 붙이고(T 접합),
 * 외곽선 가까운 끝점을 외곽에 붙인다. 접합 규칙(두께 처리)은 장면 변환이 한 곳에서 수행한다.
 */
function tidyWalls<Wl extends TidyWall>(walls: Wl[], W: number, D: number): Wl[] {
  const tan = Math.tan((T.orthoDegrees * Math.PI) / 180);
  const ortho = (w: Wl): Wl => {
    const dx = w.end[0] - w.start[0];
    const dy = w.end[1] - w.start[1];
    if (Math.abs(dy) <= Math.abs(dx) * tan) {
      const v = (w.start[1] + w.end[1]) / 2;
      return { ...w, start: [w.start[0], v], end: [w.end[0], v] };
    }
    if (Math.abs(dx) <= Math.abs(dy) * tan) {
      const u = (w.start[0] + w.end[0]) / 2;
      return { ...w, start: [u, w.start[1]], end: [u, w.end[1]] };
    }
    return w;
  };
  let out = walls.map(ortho);

  // 가까운 끝점 합치기(묶음 평균). 수평·수직 벽은 펴진 축을 유지하도록 축별로 맞춘다.
  const ends = out.flatMap((w, i) => [
    { i, k: "start" as const, p: w.start },
    { i, k: "end" as const, p: w.end },
  ]);
  const group = new Map<number, number>();
  ends.forEach((e, i) => {
    for (let j = 0; j < i; j++) {
      if (ends[j].i !== e.i && Math.hypot(ends[j].p[0] - e.p[0], ends[j].p[1] - e.p[1]) < T.snap) {
        group.set(i, group.get(j) ?? j);
        return;
      }
    }
  });
  const clusters = new Map<number, number[]>();
  ends.forEach((_, i) => {
    const root = group.get(i) ?? i;
    clusters.set(root, [...(clusters.get(root) ?? []), i]);
  });
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    // 수직 벽의 u, 수평 벽의 v를 우선 사용해 직교성을 지킨다.
    const us: number[] = [];
    const vs: number[] = [];
    for (const idx of members) {
      const e = ends[idx];
      const w = out[e.i];
      if (w.start[0] === w.end[0]) us.push(e.p[0]);
      if (w.start[1] === w.end[1]) vs.push(e.p[1]);
    }
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const u = us.length ? avg(us) : avg(members.map((idx) => ends[idx].p[0]));
    const v = vs.length ? avg(vs) : avg(members.map((idx) => ends[idx].p[1]));
    for (const idx of members) {
      const e = ends[idx];
      out[e.i] = withEnd(out[e.i], e.k, [u, v]);
    }
  }
  out = out.map(ortho);

  // T 접합: 끝점이 다른 벽 몸체에서 snap 안이면 그 벽 위로 옮긴다(끝점 근처 제외).
  out = out.map((w, i) => {
    let next = w;
    for (const k of ["start", "end"] as const) {
      const p = next[k];
      for (let j = 0; j < out.length; j++) {
        if (j === i) continue;
        const o = out[j];
        const g: WallGeom = { id: o.ref, start: o.start, end: o.end, exterior: false };
        const { t, dist, foot } = projectOnWall(g, p);
        const len = wallLength(g);
        if (dist > 1e-9 && dist < T.snap && t > T.snap && t < len - T.snap) {
          next = withEnd(next, k, foot);
          break;
        }
      }
    }
    return next;
  });

  // 외곽 맞춤
  const snapEnv = (p: Pt): Pt => [
    p[0] < T.snap ? 0 : W - p[0] < T.snap ? W : p[0],
    p[1] < T.snap ? 0 : D - p[1] < T.snap ? D : p[1],
  ];
  return out.map((w) => ({ ...w, start: snapEnv(w.start), end: snapEnv(w.end) }));
}

/* ------------------------------ 2. 차이 ------------------------------ */

export type ProposalCategory = "wall" | "opening" | "furniture" | "ceiling" | "issue";

export interface ProposalChange {
  /** 선택 키(제안 안에서 고유): wall:w1, opening:o2, furniture:f3, ceiling, issue:<key> */
  key: string;
  category: ProposalCategory;
  action: "add" | "update" | "same";
  title: string;
  detail?: string;
  /** update·same이면 대응하는 기존 항목 ID */
  targetId?: string;
  /** 대응하는 기존 값이 사용자 입력이거나 확인된 값(또는 출처 기록이 없는 값) */
  protectedValue: boolean;
  /** 적용할 수 없는 이유(예: 소속 벽을 찾지 못함) */
  blocked?: string;
  defaultSelected: boolean;
}

const CATEGORY_ORDER: ProposalCategory[] = ["wall", "opening", "furniture", "ceiling", "issue"];
const KIND_NAMES: Record<string, string> = { solid: "벽", glass: "유리 벽", door: "문", window: "창", passage: "통로" };

/** 경로(또는 하위 경로)에 사용자 입력·확인 기록이 있거나, 출처 기록이 아예 없으면 보호한다. */
function isProtected(doc: FloorPlanDocument, path: string): boolean {
  const records = (doc.provenance ?? []).filter((p) => p.path === path || p.path.startsWith(`${path}/`));
  if (!records.length) return true;
  return records.some((p) => p.origin === "user" || p.confirmed);
}

const dist = (a: Pt | readonly [number, number], b: Pt | readonly [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** 두 선분의 끝점 거리(방향 무관) */
function segmentDistance(a0: Pt | readonly [number, number], a1: Pt | readonly [number, number], b0: Pt | readonly [number, number], b1: Pt | readonly [number, number]) {
  return Math.min(Math.max(dist(a0, b0), dist(a1, b1)), Math.max(dist(a0, b1), dist(a1, b0)));
}

interface HostResult {
  wallId: string;
  exterior: boolean;
  /** 벽 시작점에서 개구부 중심까지 거리 */
  offset: number;
  width: number;
  wallLen: number;
  /** a, b의 벽 위 거리 */
  ta: number;
  tb: number;
  dir: Pt;
}

/** 문설주 두 점이 놓인 벽을 찾는다(두 점 모두 중심선 가까이, 벽 범위 안). */
function resolveHost(geoms: WallGeom[], a: Pt, b: Pt, exteriorOffset: number): HostResult | null {
  let best: { r: HostResult; score: number } | null = null;
  for (const g of geoms) {
    const len = wallLength(g);
    if (len < 1e-6) continue;
    const pa = projectOnWall(g, a);
    const pb = projectOnWall(g, b);
    // 외벽의 도면선은 실내 마감면이고 중심선은 두께 절반 바깥이다.
    const extra = g.exterior ? exteriorOffset : 0;
    const score = Math.max(pa.dist, pb.dist);
    if (score > T.openingHost + extra) continue;
    if (Math.abs(pb.t - pa.t) < L.openingWidth.min * 0.5) continue;
    const dir: Pt = [(g.end[0] - g.start[0]) / len, (g.end[1] - g.start[1]) / len];
    const r: HostResult = { wallId: g.id, exterior: g.exterior, offset: (pa.t + pb.t) / 2, width: Math.abs(pb.t - pa.t), wallLen: len, ta: pa.t, tb: pb.t, dir };
    if (!best || score < best.score) best = { r, score };
  }
  return best?.r ?? null;
}

/** 제안 벽과 기존 벽 짝짓기(가까운 순, 일대일) */
function matchWalls(doc: FloorPlanDocument, walls: ProposedWall[]): Map<string, FloorPlanWall> {
  const pairs: { ref: string; wall: FloorPlanWall; d: number }[] = [];
  for (const p of walls) for (const w of doc.walls) {
    const d = segmentDistance(p.start, p.end, w.start, w.end);
    if (d < T.wallMatch) pairs.push({ ref: p.ref, wall: w, d });
  }
  pairs.sort((x, y) => x.d - y.d);
  const out = new Map<string, FloorPlanWall>();
  const used = new Set<string>();
  for (const pr of pairs) {
    if (out.has(pr.ref) || used.has(pr.wall.id)) continue;
    out.set(pr.ref, pr.wall);
    used.add(pr.wall.id);
  }
  return out;
}

/** 현재 문서 대비 제안의 변경 목록. 문서가 바뀌면 다시 계산한다. */
export function planChanges(doc: FloorPlanDocument, proposal: AiProposal): ProposalChange[] {
  const changes: ProposalChange[] = [];
  const fmt = (n: number) => `${Math.round(n * 100) / 100}`;
  const ptText = (p: Pt) => `(${fmt(p[0])}, ${fmt(p[1])})`;

  /* 벽 */
  const wallMatch = matchWalls(doc, proposal.walls);
  for (const p of proposal.walls) {
    const name = KIND_NAMES[p.kind];
    const target = wallMatch.get(p.ref);
    const geometry = `${ptText(p.start)} → ${ptText(p.end)}, 길이 ${fmt(wallLength(p))}m, 두께 ${fmt(p.thickness)}m${p.thicknessRead ? "" : "(기본값)"}`;
    if (!target) {
      changes.push({ key: `wall:${p.ref}`, category: "wall", action: "add", title: `${name} 추가`, detail: geometry, protectedValue: false, defaultSelected: true });
      continue;
    }
    const i = doc.walls.indexOf(target);
    const same =
      segmentDistance(p.start, p.end, target.start, target.end) < 0.03 && p.kind === target.kind && (!p.thicknessRead || Math.abs(p.thickness - target.thickness) < 0.01);
    const protectedValue = isProtected(doc, `/walls/${i}`);
    changes.push({
      key: `wall:${p.ref}`,
      category: "wall",
      action: same ? "same" : "update",
      title: same ? `${name} '${target.id}' 일치` : `${name} '${target.id}' 변경`,
      detail: same ? undefined : `${geometry} (현재 ${ptText(target.start as Pt)} → ${ptText(target.end as Pt)}, ${KIND_NAMES[target.kind]}, 두께 ${fmt(target.thickness)}m)`,
      targetId: target.id,
      protectedValue,
      defaultSelected: !same && !protectedValue,
    });
  }

  /* 개구부: 기존 벽 + 추가 제안 벽을 후보로 소속 벽을 찾는다 */
  const geoms: WallGeom[] = [
    ...wallGeoms(doc),
    ...proposal.walls.filter((p) => !wallMatch.has(p.ref)).map((p) => ({ id: `ai:${p.ref}`, start: p.start, end: p.end, exterior: false })),
  ];
  const usedOpenings = new Set<string>();
  for (const p of proposal.openings) {
    const name = KIND_NAMES[p.kind];
    const host = resolveHost(geoms, p.a, p.b, doc.envelope.wallThickness / 2);
    const key = `opening:${p.ref}`;
    const where = host ? (host.wallId.startsWith("ai:") ? `추가할 벽 ${host.wallId.slice(3)}` : `벽 '${host.wallId}'`) : "";
    if (!host) {
      changes.push({ key, category: "opening", action: "add", title: `${name} 추가`, detail: `${ptText(p.a)}–${ptText(p.b)}`, protectedValue: false, blocked: "놓일 벽을 찾지 못함", defaultSelected: false });
      continue;
    }
    if (p.kind === "window" && !host.exterior) {
      changes.push({ key, category: "opening", action: "add", title: `${name} 추가`, detail: where, protectedValue: false, blocked: "내부 벽의 창은 지원하지 않음", defaultSelected: false });
      continue;
    }
    const detail = `${where}, 시작점에서 ${fmt(host.offset)}m, 폭 ${fmt(host.width)}m`;
    const existing = host.wallId.startsWith("ai:")
      ? undefined
      : doc.openings.find((o) => o.wallId === host.wallId && !usedOpenings.has(o.id) && Math.abs(o.offset - host.offset) < Math.max(0.3, Math.max(o.width, host.width) / 2));
    if (!existing) {
      changes.push({ key, category: "opening", action: "add", title: `${name} 추가`, detail, protectedValue: false, defaultSelected: true });
      continue;
    }
    usedOpenings.add(existing.id);
    const i = doc.openings.indexOf(existing);
    const same = existing.kind === p.kind && Math.abs(existing.offset - host.offset) < 0.05 && Math.abs(existing.width - host.width) < 0.05;
    const protectedValue = isProtected(doc, `/openings/${i}`);
    changes.push({
      key,
      category: "opening",
      action: same ? "same" : "update",
      title: same ? `${KIND_NAMES[existing.kind]} '${existing.id}' 일치` : `${KIND_NAMES[existing.kind]} '${existing.id}' → ${name} 변경`,
      detail: same ? undefined : `${detail} (현재 ${fmt(existing.offset)}m, 폭 ${fmt(existing.width)}m)`,
      targetId: existing.id,
      protectedValue,
      defaultSelected: !same && !protectedValue,
    });
  }

  /* 가구 */
  const usedFurniture = new Set<string>();
  for (const p of proposal.furniture) {
    const name = p.label ?? p.kind;
    const detail = `중심 ${ptText(p.center)}, ${fmt(p.size[0])} × ${fmt(p.size[2])}m, 높이 ${fmt(p.size[1])}m(기본값)`;
    const existing = (doc.furniture ?? [])
      .filter((f) => !usedFurniture.has(f.id) && (f.kind === p.kind || f.kind === "unknown" || p.kind === "unknown"))
      .map((f) => ({ f, d: dist([f.position[0], f.position[2]], p.center) }))
      .filter((x) => x.d < T.furnitureMatch)
      .sort((x, y) => x.d - y.d)[0]?.f;
    if (!existing) {
      changes.push({ key: `furniture:${p.ref}`, category: "furniture", action: "add", title: `가구 추가: ${name}`, detail, protectedValue: false, defaultSelected: true });
      continue;
    }
    usedFurniture.add(existing.id);
    const i = (doc.furniture ?? []).indexOf(existing);
    const same =
      existing.kind === p.kind &&
      dist([existing.position[0], existing.position[2]], p.center) < 0.1 &&
      Math.abs(existing.size[0] - p.size[0]) < 0.1 &&
      Math.abs(existing.size[2] - p.size[2]) < 0.1;
    const protectedValue = isProtected(doc, `/furniture/${i}`);
    changes.push({
      key: `furniture:${p.ref}`,
      category: "furniture",
      action: same ? "same" : "update",
      title: same ? `가구 '${existing.label ?? existing.id}' 일치` : `가구 '${existing.label ?? existing.id}' 변경`,
      detail: same ? undefined : detail,
      targetId: existing.id,
      protectedValue,
      defaultSelected: !same && !protectedValue,
    });
  }

  /* 천장 높이 */
  if (proposal.ceilingHeight) {
    const same = Math.abs(proposal.ceilingHeight.value - doc.ceilingHeight) < 0.005;
    const protectedValue = isProtected(doc, "/ceilingHeight");
    changes.push({
      key: "ceiling",
      category: "ceiling",
      action: same ? "same" : "update",
      title: same ? `천장 높이 ${doc.ceilingHeight}m 일치` : `천장 높이 ${doc.ceilingHeight}m → ${proposal.ceilingHeight.value}m`,
      detail: `도면 표기 '${proposal.ceilingHeight.text}'`,
      protectedValue,
      defaultSelected: !same && !protectedValue,
    });
  }

  /* 확인 항목 */
  const existingMessages = new Set((doc.issues ?? []).map((s) => s.message));
  for (const s of proposal.issues) {
    const same = existingMessages.has(s.message);
    changes.push({
      key: `issue:${s.key}`,
      category: "issue",
      action: same ? "same" : "add",
      title: { missing: "누락", conflict: "충돌", unsupported: "미지원", assumption: "가정" }[s.kind],
      detail: s.message,
      protectedValue: false,
      defaultSelected: !same,
    });
  }

  return changes.sort((x, y) => CATEGORY_ORDER.indexOf(x.category) - CATEGORY_ORDER.indexOf(y.category));
}

/** 기본 선택(추가 + 보호되지 않은 변경) */
export function defaultSelection(changes: ProposalChange[]): Set<string> {
  return new Set(changes.filter((c) => c.defaultSelected).map((c) => c.key));
}

/* ------------------------------ 3. 적용 ------------------------------ */

export interface ApplyResult {
  doc: FloorPlanDocument;
  applied: string[];
  /** 선택했지만 적용하지 못한 항목과 이유 */
  skipped: string[];
}

/** 선택한 변경만 적용한다. 차이는 적용 시점의 문서로 다시 계산한다. */
export function applyProposal(doc: FloorPlanDocument, proposal: AiProposal, selected: ReadonlySet<string>): ApplyResult {
  const changes = planChanges(doc, proposal).filter((c) => selected.has(c.key) && c.action !== "same");
  const applied: string[] = [];
  const skipped: string[] = [];
  const note = `AI 초안(${proposal.meta.provider} ${proposal.meta.model}, ${proposal.meta.at.slice(0, 10)})`;
  const touched = new Set<"walls" | "openings" | "furniture">();
  let next = doc;

  for (const c of changes) {
    if (c.blocked) {
      skipped.push(`${c.title}: ${c.blocked}`);
      continue;
    }
    const ref = c.key.slice(c.key.indexOf(":") + 1);
    if (c.category === "wall") {
      const p = proposal.walls.find((w) => w.ref === ref);
      if (!p) continue;
      const source = { origin: "source" as const, confirmed: false, note, region: p.region, confidence: p.confidence };
      let index: number;
      if (c.action === "add") {
        const wall: FloorPlanWall = { id: nextId(next, "wall"), kind: p.kind, start: p.start, end: p.end, thickness: p.thickness };
        index = next.walls.length;
        next = { ...next, walls: [...next.walls, wall] };
      } else {
        index = next.walls.findIndex((w) => w.id === c.targetId);
        if (index < 0) continue;
        const cur = next.walls[index];
        const wall: FloorPlanWall = { ...cur, kind: p.kind, start: p.start, end: p.end, thickness: p.thicknessRead ? p.thickness : cur.thickness };
        next = { ...next, walls: next.walls.map((w, k) => (k === index ? wall : w)) };
      }
      next = setProvenance(next, { path: `/walls/${index}`, ...source });
      if (!p.thicknessRead && c.action === "add") {
        next = setProvenance(next, { path: `/walls/${index}/thickness`, origin: "default", confirmed: false, note: `도면에서 두께를 읽지 못해 기본값 ${p.thickness}m` });
      }
      touched.add("walls");
      applied.push(c.title);
    } else if (c.category === "opening") {
      const p = proposal.openings.find((o) => o.ref === ref);
      if (!p) continue;
      // 벽을 적용한 뒤의 문서에서 소속 벽을 다시 찾는다(추가하지 않은 제안 벽 위의 개구부는 기존 벽에서만 찾는다).
      const host = resolveHost(wallGeoms(next), p.a, p.b, next.envelope.wallThickness / 2);
      if (!host) {
        skipped.push(`${c.title}: 놓일 벽을 찾지 못함(소속 벽을 적용하지 않았을 수 있음)`);
        continue;
      }
      if (p.kind === "window" && !host.exterior) {
        skipped.push(`${c.title}: 내부 벽의 창은 지원하지 않음`);
        continue;
      }
      const width = mm(Math.min(Math.max(host.width, L.openingWidth.min), L.openingWidth.max, host.wallLen));
      const offset = clampOffset(host.wallLen, width, host.offset);
      const d = EDITOR_DEFAULTS.opening[p.kind];
      const height = mm(Math.min(d.height, next.ceilingHeight - d.bottom - 0.05));
      const door = p.kind === "door" ? doorLeaf(p, host) : undefined;
      let index: number;
      if (c.action === "add") {
        const opening: FloorPlanOpening = { id: nextId(next, p.kind), wallId: host.wallId, kind: p.kind, offset, width, height, bottom: d.bottom, ...(door ? { door } : {}) };
        index = next.openings.length;
        next = { ...next, openings: [...next.openings, opening] };
        next = setProvenance(next, {
          path: `/openings/${index}/height`,
          origin: "default",
          confirmed: false,
          note: `평면도에 높이가 없어 기본값 ${height}m${d.bottom ? `, 하단 ${d.bottom}m` : ""}`,
        });
      } else {
        index = next.openings.findIndex((o) => o.id === c.targetId);
        if (index < 0) continue;
        const cur = next.openings[index];
        const kindChanged = cur.kind !== p.kind;
        const opening: FloorPlanOpening = {
          ...cur,
          wallId: host.wallId,
          kind: p.kind,
          offset,
          width,
          ...(kindChanged ? { height, bottom: d.bottom } : {}),
        };
        if (p.kind === "door") opening.door = kindChanged || !cur.door ? door : { ...cur.door, ...(door ? { hinge: door.hinge, swing: door.swing } : {}) };
        else delete opening.door;
        next = { ...next, openings: next.openings.map((o, k) => (k === index ? opening : o)) };
      }
      next = setProvenance(next, { path: `/openings/${index}`, origin: "source", confirmed: false, note, region: p.region, confidence: p.confidence });
      touched.add("openings");
      applied.push(c.title);
    } else if (c.category === "furniture") {
      const p = proposal.furniture.find((f) => f.ref === ref);
      if (!p) continue;
      const list = next.furniture ?? [];
      const body = {
        kind: p.kind,
        ...(p.label ? { label: p.label.slice(0, 200) } : {}),
        position: [p.center[0], 0, p.center[1]] as [number, number, number],
        size: p.size,
        ...(p.rotation ? { rotation: p.rotation } : {}),
      };
      let index: number;
      if (c.action === "add") {
        const item: FloorPlanFurniture = { id: nextId(next, p.kind === "unknown" ? "item" : p.kind), ...body };
        index = list.length;
        next = { ...next, furniture: [...list, item] };
      } else {
        index = list.findIndex((f) => f.id === c.targetId);
        if (index < 0) continue;
        const { label: _label, rotation: _rotation, ...rest } = list[index];
        void _label;
        void _rotation;
        const item: FloorPlanFurniture = { ...rest, ...body, id: list[index].id };
        next = { ...next, furniture: list.map((f, k) => (k === index ? item : f)) };
      }
      next = setProvenance(next, { path: `/furniture/${index}`, origin: "source", confirmed: false, note: `${note}. 높이는 종류별 기본값`, region: p.region, confidence: p.confidence });
      touched.add("furniture");
      applied.push(c.title);
    } else if (c.category === "ceiling" && proposal.ceilingHeight) {
      next = setProvenance({ ...next, ceilingHeight: proposal.ceilingHeight.value }, { path: "/ceilingHeight", origin: "source", confirmed: false, note: `${note}: 도면 표기 '${proposal.ceilingHeight.text}'` });
      applied.push(c.title);
    } else if (c.category === "issue") {
      const s = proposal.issues.find((x) => `issue:${x.key}` === c.key);
      if (!s) continue;
      const issue: FloorPlanStoredIssue = { id: nextIssueId(next), kind: s.kind, ...(s.path ? { path: s.path } : {}), message: s.message.slice(0, 1000), resolved: false };
      next = { ...next, issues: [...(next.issues ?? []), issue] };
      applied.push(`${c.title}: ${s.message}`);
    }
  }
  for (const key of touched) next = setCompleteness(next, key, "unreviewed");
  return { doc: next, applied, skipped };
}

/** 문서 확인 항목 ID(ai-issue-n) */
function nextIssueId(doc: FloorPlanDocument): string {
  const used = new Set((doc.issues ?? []).map((s) => s.id));
  for (let n = 1; ; n++) if (!used.has(`ai-issue-${n}`)) return `ai-issue-${n}`;
}

/** 경첩·열림 방향을 벽 진행 방향 기준으로 바꾼다. 모르면 기본값(시작 쪽 경첩, 왼쪽 법선 = 외벽에서는 실내). */
function doorLeaf(p: ProposedOpening, host: HostResult): NonNullable<FloorPlanOpening["door"]> {
  const base = { ...EDITOR_DEFAULTS.door };
  if (p.hinge) {
    const hingeT = p.hinge === "a" ? host.ta : host.tb;
    const otherT = p.hinge === "a" ? host.tb : host.ta;
    base.hinge = hingeT <= otherT ? "start" : "end";
  }
  if (p.swingToward) {
    const mid: Pt = [(p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2];
    // 왼쪽 법선(u 오른쪽·v 아래 좌표에서 진행 방향 (du, dv)의 왼쪽 = (−dv, du))
    const side = (p.swingToward[0] - mid[0]) * -host.dir[1] + (p.swingToward[1] - mid[1]) * host.dir[0];
    if (Math.abs(side) > 1e-6) base.swing = side > 0 ? "pos" : "neg";
  }
  return base;
}

/* ------------------------------ 표시 보조 ------------------------------ */

/** 가구 바닥 영역 [u0, v0, u1, v1] (회전 0·±90·180 기준) */
export function furnitureFootprint(f: Pick<ProposedFurniture, "center" | "size" | "rotation">): [number, number, number, number] {
  const sideways = Math.abs(Math.abs(f.rotation) - 90) < 1;
  const su = sideways ? f.size[2] : f.size[0];
  const sv = sideways ? f.size[0] : f.size[2];
  return [f.center[0] - su / 2, f.center[1] - sv / 2, f.center[0] + su / 2, f.center[1] + sv / 2];
}
