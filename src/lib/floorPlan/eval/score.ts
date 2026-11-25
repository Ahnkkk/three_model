import { pointOnWall, wallGeoms, type Pt } from "../editor";
import type { FloorPlanDocument } from "../schema";

/**
 * 도면 인식 채점(단기 계획 S5). 정답 도면과 결과 도면(AI 초안을 적용한 문서 또는 수동 입력 문서)을 비교한다. 순수 함수.
 *
 * 전제: 두 문서는 같은 보정 기준(같은 외곽·원점)의 도면 m 좌표다. 외곽 크기가 다르면 frame에 경고를 남긴다.
 *
 * 짝짓기: 항목 쌍의 비용을 계산해 작은 것부터 일대일로 짝짓는다(결정적 그리디). 비용이 허용 범위를 넘는 쌍은 짝짓지 않는다.
 * - 벽: 끝점 오차(두 끝점 거리 중 큰 값, 방향 무관). 벽을 나눠 그린 경우를 위해 길이 기준 재현율·정밀도도 따로 계산한다.
 * - 개구부: 중심 거리(같은 방향의 벽 위에 있을 때만). 종류가 다르면 비용을 더해 같은 종류를 먼저 짝짓는다.
 * - 가구: 바닥 중심 거리. 종류가 다르면 비용을 더한다. 크기는 회전을 반영한 축 정렬 바닥 영역으로 비교한다.
 * - 치수: 재는 방향(가로·세로)이 같고, 재는 축 위 구간 양 끝 오차가 허용 범위 안이면 같은 구간으로 본다.
 *   치수선은 벽에서 떨어져 있으므로 수직 방향 위치는 짝짓기 순서에만 조금 반영한다.
 *
 * "추정 수정 수"는 정답과 다른 항목 수(누락 + 오검출 + 허용 오차를 넘는 일치 항목 + 천장 높이)다.
 * 실제 수동 수정 횟수·시간은 따로 측정한다.
 */

export const SCORE_TOLERANCE = {
  /** 벽 짝짓기 끝점 오차 상한(m) */
  wallMatch: 0.3,
  /** 이 이하면 수정이 필요 없는 벽(m) */
  wallExact: 0.05,
  wallThicknessExact: 0.03,
  /** 길이 기준 재현율: 다른 쪽 벽 선분까지 이 거리 안이면 덮인 것으로 본다(m) */
  wallCoverage: 0.1,
  coverageStep: 0.05,
  /** 평행으로 보는 각도 차이(도) */
  parallelDegrees: 10,
  openingMatch: 0.3,
  openingExact: 0.05,
  /** 결과 개구부의 소속 벽이 정답 개구부 중심에서 이 거리 안을 지나야 소속 벽이 맞다(m) */
  openingHost: 0.1,
  furnitureMatch: 0.6,
  furnitureExact: 0.15,
  furnitureSizeExact: 0.15,
  rotationExact: 45,
  dimensionSpan: 0.15,
  /** 표기 값 일치: max(절대, 상대 × 값) */
  dimensionValueAbs: 0.005,
  dimensionValueRel: 0.001,
  ceiling: 0.01,
  /** 두 문서의 외곽 크기 차이 경고 기준(m) */
  frame: 0.05,
} as const;

const T = SCORE_TOLERANCE;

/** 정답 치수: 도면에 적힌 값과 그 치수가 재는 구간(도면 m, 치수선 위의 점이어도 된다) */
export interface TruthDimension {
  text?: string;
  /** 도면에 적힌 값(m). 기하와 다르게 적힌 치수도 적힌 값을 넣고 conflict: true로 표시한다. */
  value: number;
  a: Pt;
  b: Pt;
  /** 적힌 값이 실제 구간 길이와 달라 충돌로 표시되어야 하는지 */
  conflict?: boolean;
}

/** 결과 치수(AI 제안의 DimensionCheck와 같은 모양) */
export interface PredictedDimension {
  text: string;
  stated: number | null;
  a: Pt;
  b: Pt;
  status: "ok" | "conflict" | "unread";
}

export interface ScoreInput {
  truth: FloorPlanDocument;
  predicted: FloorPlanDocument;
  truthDimensions?: TruthDimension[];
  predictedDimensions?: PredictedDimension[];
  /** 도면에 천장 높이 표기가 없어 결과가 '누락'을 표시해야 하는지 */
  ceilingHeightMissing?: boolean;
}

export interface ErrorStat {
  mean: number | null;
  max: number | null;
}

export interface Detection {
  truth: number;
  predicted: number;
  matched: number;
  /** 정답 중 짝이 없는 항목(ID) */
  missed: string[];
  /** 결과 중 짝이 없는 항목(ID) */
  extra: string[];
  /** matched / truth. 정답이 없으면 null */
  recall: number | null;
  /** matched / predicted. 결과가 없으면 null */
  precision: number | null;
  /** 짝은 지었지만 허용 오차를 넘거나 속성이 달라 고쳐야 하는 정답 항목(ID) */
  needsEdit: string[];
}

export interface WallScore extends Detection {
  kindErrors: string[];
  endpointError: ErrorStat;
  thicknessError: ErrorStat;
  /** 정답 벽 길이 중 결과 벽이 덮는 비율 */
  lengthRecall: number | null;
  /** 결과 벽 길이 중 정답 벽이 덮는 비율 */
  lengthPrecision: number | null;
  pairs: { truth: string; predicted: string; endpointError: number }[];
}

export interface OpeningScore extends Detection {
  kindErrors: string[];
  hostErrors: string[];
  centerError: ErrorStat;
  widthError: ErrorStat;
  /** 양쪽 모두 문짝 정보가 있는 문 짝 수 */
  doorsCompared: number;
  hingeErrors: string[];
  swingErrors: string[];
}

export interface FurnitureScore extends Detection {
  kindErrors: string[];
  centerError: ErrorStat;
  sizeError: ErrorStat;
  rotationErrors: string[];
}

export interface CeilingScore {
  truth: number;
  predicted: number;
  /** 결과 문서의 천장 높이 출처(provenance origin). 기록이 없으면 null */
  origin: string | null;
  missingExpected: boolean;
  /** 결과 문서에 천장 높이 확인 항목(미해결)이 있는지 */
  flagged: boolean;
  ok: boolean;
}

export interface DimensionScore {
  truth: number;
  predicted: number;
  /** 구간을 맞게 연결한 정답 치수 수 */
  linked: number;
  /** 구간과 값이 모두 맞은 정답 치수 수 */
  exact: number;
  linkAccuracy: number | null;
  exactAccuracy: number | null;
  missed: string[];
  extra: string[];
  /** 구간은 맞지만 값을 잘못 읽은 치수 */
  valueErrors: string[];
  /** 값은 읽었지만 다른 구간에 연결한 치수(짝 없는 결과 중 짝 없는 정답과 값이 같은 것) */
  misattached: string[];
  conflictsExpected: number;
  conflictsDetected: number;
  /** 충돌이 아닌데 충돌로 표시한 치수 */
  falseConflicts: string[];
}

export interface FloorPlanScore {
  tolerance: typeof SCORE_TOLERANCE;
  frame: { ok: boolean; message?: string };
  walls: WallScore;
  openings: OpeningScore;
  furniture: FurnitureScore;
  ceiling: CeilingScore;
  dimensions: DimensionScore | null;
  corrections: { walls: number; openings: number; furniture: number; ceiling: number; total: number };
}

/* ------------------------------ 공용 ------------------------------ */

const dist = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]);
const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d + 0;
const ratio = (a: number, b: number) => (b > 0 ? round(a / b, 4) : null);

function stat(values: number[]): ErrorStat {
  if (!values.length) return { mean: null, max: null };
  return { mean: round(values.reduce((s, v) => s + v, 0) / values.length), max: round(Math.max(...values)) };
}

/** 비용이 작은 쌍부터 일대일 짝짓기. cost가 null이면 짝지을 수 없는 쌍이다. */
function greedyMatch(n: number, m: number, cost: (i: number, j: number) => number | null): [number, number][] {
  const pairs: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const c = cost(i, j);
      if (c !== null) pairs.push([i, j, c]);
    }
  }
  pairs.sort((p, q) => p[2] - q[2] || p[0] - q[0] || p[1] - q[1]);
  const usedI = new Set<number>();
  const usedJ = new Set<number>();
  const out: [number, number][] = [];
  for (const [i, j] of pairs) {
    if (usedI.has(i) || usedJ.has(j)) continue;
    usedI.add(i);
    usedJ.add(j);
    out.push([i, j]);
  }
  return out;
}

function detection(truthIds: string[], predIds: string[], matches: [number, number][], needsEdit: string[]): Detection {
  const mi = new Set(matches.map((m) => m[0]));
  const mj = new Set(matches.map((m) => m[1]));
  return {
    truth: truthIds.length,
    predicted: predIds.length,
    matched: matches.length,
    missed: truthIds.filter((_, i) => !mi.has(i)),
    extra: predIds.filter((_, j) => !mj.has(j)),
    recall: ratio(matches.length, truthIds.length),
    precision: ratio(matches.length, predIds.length),
    needsEdit,
  };
}

interface Seg {
  a: Pt;
  b: Pt;
}

const segLen = (s: Seg) => dist(s.a, s.b);
const segDir = (s: Seg): Pt => {
  const l = segLen(s) || 1;
  return [(s.b[0] - s.a[0]) / l, (s.b[1] - s.a[1]) / l];
};
const parallel = (d1: Pt, d2: Pt) => Math.abs(d1[0] * d2[1] - d1[1] * d2[0]) <= Math.sin((T.parallelDegrees * Math.PI) / 180);

function pointSegDist(p: Pt, s: Seg): number {
  const l = segLen(s);
  if (l === 0) return dist(p, s.a);
  const d = segDir(s);
  const t = Math.max(0, Math.min(l, (p[0] - s.a[0]) * d[0] + (p[1] - s.a[1]) * d[1]));
  return dist(p, [s.a[0] + d[0] * t, s.a[1] + d[1] * t]);
}

/** 방향과 무관한 끝점 오차 */
function endpointError(s: Seg, o: Seg): number {
  return Math.min(Math.max(dist(s.a, o.a), dist(s.b, o.b)), Math.max(dist(s.a, o.b), dist(s.b, o.a)));
}

/** src 선분 길이 중 dst 선분(평행, coverage 거리 안)에 덮이는 길이 */
function coveredLength(src: Seg[], dst: Seg[]): { covered: number; total: number } {
  let covered = 0;
  let total = 0;
  for (const s of src) {
    const len = segLen(s);
    total += len;
    if (!len) continue;
    const dir = segDir(s);
    const near = dst.filter((d) => segLen(d) > 0 && parallel(dir, segDir(d)));
    const n = Math.max(1, Math.ceil(len / T.coverageStep));
    for (let k = 0; k < n; k++) {
      const t = ((k + 0.5) / n) * len;
      const p: Pt = [s.a[0] + dir[0] * t, s.a[1] + dir[1] * t];
      if (near.some((d) => pointSegDist(p, d) <= T.wallCoverage)) covered += len / n;
    }
  }
  return { covered, total };
}

/* ------------------------------ 벽 ------------------------------ */

function scoreWalls(truth: FloorPlanDocument, pred: FloorPlanDocument): { score: WallScore; corrections: number } {
  const tw = truth.walls;
  const pw = pred.walls;
  const seg = (w: { start: Pt | readonly [number, number]; end: Pt | readonly [number, number] }): Seg => ({ a: [w.start[0], w.start[1]], b: [w.end[0], w.end[1]] });
  const matches = greedyMatch(tw.length, pw.length, (i, j) => {
    const e = endpointError(seg(tw[i]), seg(pw[j]));
    return e <= T.wallMatch ? e : null;
  });
  const kindErrors: string[] = [];
  const needsEdit: string[] = [];
  const endErr: number[] = [];
  const thickErr: number[] = [];
  const pairs: WallScore["pairs"] = [];
  for (const [i, j] of matches) {
    const e = endpointError(seg(tw[i]), seg(pw[j]));
    const th = Math.abs(tw[i].thickness - pw[j].thickness);
    endErr.push(e);
    thickErr.push(th);
    pairs.push({ truth: tw[i].id, predicted: pw[j].id, endpointError: round(e) });
    const kindWrong = tw[i].kind !== pw[j].kind;
    if (kindWrong) kindErrors.push(tw[i].id);
    if (kindWrong || e > T.wallExact || th > T.wallThicknessExact) needsEdit.push(tw[i].id);
  }
  const det = detection(
    tw.map((w) => w.id),
    pw.map((w) => w.id),
    matches,
    needsEdit,
  );
  const rec = coveredLength(tw.map(seg), pw.map(seg));
  const prec = coveredLength(pw.map(seg), tw.map(seg));
  return {
    score: {
      ...det,
      kindErrors,
      endpointError: stat(endErr),
      thicknessError: stat(thickErr),
      lengthRecall: ratio(rec.covered, rec.total),
      lengthPrecision: ratio(prec.covered, prec.total),
      pairs,
    },
    corrections: det.missed.length + det.extra.length + needsEdit.length,
  };
}

/* ------------------------------ 개구부 ------------------------------ */

interface OpeningGeo {
  id: string;
  kind: string;
  center: Pt;
  dir: Pt;
  width: number;
  host: Seg;
  hinge: Pt | null;
  swing: Pt | null;
}

function openingGeos(doc: FloorPlanDocument): OpeningGeo[] {
  const walls = new Map(wallGeoms(doc).map((w) => [w.id, w]));
  return doc.openings.flatMap((o) => {
    const w = walls.get(o.wallId);
    if (!w) return [];
    const { p, dir } = pointOnWall(w, o.offset);
    const half = o.width / 2;
    const door = o.kind === "door" ? o.door : undefined;
    const hinge: Pt | null = door ? (door.hinge === "start" ? [p[0] - dir[0] * half, p[1] - dir[1] * half] : [p[0] + dir[0] * half, p[1] + dir[1] * half]) : null;
    // pos = 벽 진행 방향의 왼쪽 법선(-dv, du)
    const swing: Pt | null = door ? (door.swing === "pos" ? [-dir[1], dir[0]] : [dir[1], -dir[0]]) : null;
    return [{ id: o.id, kind: o.kind, center: p, dir, width: o.width, host: { a: w.start, b: w.end }, hinge, swing }];
  });
}

function scoreOpenings(truth: FloorPlanDocument, pred: FloorPlanDocument): { score: OpeningScore; corrections: number } {
  const to = openingGeos(truth);
  const po = openingGeos(pred);
  const matches = greedyMatch(to.length, po.length, (i, j) => {
    if (!parallel(to[i].dir, po[j].dir)) return null;
    const d = dist(to[i].center, po[j].center);
    if (d > T.openingMatch) return null;
    return d + (to[i].kind === po[j].kind ? 0 : 0.2);
  });
  const kindErrors: string[] = [];
  const hostErrors: string[] = [];
  const hingeErrors: string[] = [];
  const swingErrors: string[] = [];
  const needsEdit: string[] = [];
  const centerErr: number[] = [];
  const widthErr: number[] = [];
  let doorsCompared = 0;
  for (const [i, j] of matches) {
    const t = to[i];
    const p = po[j];
    const c = dist(t.center, p.center);
    const w = Math.abs(t.width - p.width);
    centerErr.push(c);
    widthErr.push(w);
    let wrong = c > T.openingExact || w > T.openingExact;
    if (t.kind !== p.kind) {
      kindErrors.push(t.id);
      wrong = true;
    }
    // 소속 벽: 결과 개구부가 놓인 벽이 정답 개구부 자리를 지나는지(벽을 나눠 그린 경우도 맞게 본다)
    if (pointSegDist(t.center, p.host) > T.openingHost) {
      hostErrors.push(t.id);
      wrong = true;
    }
    if (t.hinge && p.hinge && t.swing && p.swing) {
      doorsCompared++;
      // 경첩: 같은 쪽 문설주인지(폭의 절반보다 가까운 쪽)
      if (dist(t.hinge, p.hinge) > Math.max(t.width, p.width) / 2) {
        hingeErrors.push(t.id);
        wrong = true;
      }
      if (t.swing[0] * p.swing[0] + t.swing[1] * p.swing[1] <= 0) {
        swingErrors.push(t.id);
        wrong = true;
      }
    }
    if (wrong) needsEdit.push(t.id);
  }
  const det = detection(
    to.map((o) => o.id),
    po.map((o) => o.id),
    matches,
    needsEdit,
  );
  return {
    score: { ...det, kindErrors, hostErrors, centerError: stat(centerErr), widthError: stat(widthErr), doorsCompared, hingeErrors, swingErrors },
    corrections: det.missed.length + det.extra.length + needsEdit.length,
  };
}

/* ------------------------------ 가구 ------------------------------ */

/** 회전과 무관한 종류(원형·식물 등)와 180° 대칭인 종류. 그 밖의 종류는 정면 방향(360°)을 비교한다. */
const ROTATION_FREE = new Set(["plant", "floorLamp", "roundMeetingTable"]);
const ROTATION_HALF = new Set(["rug", "coffeeTable", "sideTable", "conferenceTable", "hDesk"]);

function angleDiff(a: number, b: number, period: number): number {
  const d = (((a - b) % period) + period) % period;
  return Math.min(d, period - d);
}

/** 회전을 반영한 축 정렬 바닥 영역 크기 [u 방향, v 방향] */
function footprintExtent(size: readonly number[], rotation: number): Pt {
  const r = (rotation * Math.PI) / 180;
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  return [size[0] * c + size[2] * s, size[0] * s + size[2] * c];
}

function scoreFurniture(truth: FloorPlanDocument, pred: FloorPlanDocument): { score: FurnitureScore; corrections: number } {
  const tf = truth.furniture ?? [];
  const pf = pred.furniture ?? [];
  const center = (f: (typeof tf)[number]): Pt => [f.position[0], f.position[2]];
  const matches = greedyMatch(tf.length, pf.length, (i, j) => {
    const d = dist(center(tf[i]), center(pf[j]));
    if (d > T.furnitureMatch) return null;
    return d + (tf[i].kind === pf[j].kind ? 0 : 0.3);
  });
  const kindErrors: string[] = [];
  const rotationErrors: string[] = [];
  const needsEdit: string[] = [];
  const centerErr: number[] = [];
  const sizeErr: number[] = [];
  for (const [i, j] of matches) {
    const t = tf[i];
    const p = pf[j];
    const c = dist(center(t), center(p));
    const et = footprintExtent(t.size, t.rotation ?? 0);
    const ep = footprintExtent(p.size, p.rotation ?? 0);
    const s = Math.max(Math.abs(et[0] - ep[0]), Math.abs(et[1] - ep[1]));
    centerErr.push(c);
    sizeErr.push(s);
    let wrong = c > T.furnitureExact || s > T.furnitureSizeExact;
    if (t.kind !== p.kind) {
      kindErrors.push(t.id);
      wrong = true;
    }
    if (!ROTATION_FREE.has(t.kind)) {
      const period = ROTATION_HALF.has(t.kind) ? 180 : 360;
      if (angleDiff(t.rotation ?? 0, p.rotation ?? 0, period) > T.rotationExact) {
        rotationErrors.push(t.id);
        wrong = true;
      }
    }
    if (wrong) needsEdit.push(t.id);
  }
  const det = detection(
    tf.map((f) => f.id),
    pf.map((f) => f.id),
    matches,
    needsEdit,
  );
  return {
    score: { ...det, kindErrors, centerError: stat(centerErr), sizeError: stat(sizeErr), rotationErrors },
    corrections: det.missed.length + det.extra.length + needsEdit.length,
  };
}

/* ------------------------------ 천장 높이 ------------------------------ */

function scoreCeiling(truth: FloorPlanDocument, pred: FloorPlanDocument, missingExpected: boolean): CeilingScore {
  const origin = pred.provenance?.find((p) => p.path === "/ceilingHeight")?.origin ?? null;
  const flagged = (pred.issues ?? []).some((i) => i.path === "/ceilingHeight" && !i.resolved);
  // 표기가 있는 도면: 값이 맞고 기본값이 아니어야 한다(기본값이 우연히 같아도 읽은 것이 아니다).
  // 출처 기록이 없는 값은 편집기와 같이 확정값으로 본다. 표기가 없는 도면: 누락을 확인 항목으로 알려야 한다.
  const read = origin !== "default";
  const ok = missingExpected ? flagged : read && Math.abs(truth.ceilingHeight - pred.ceilingHeight) <= T.ceiling;
  return { truth: truth.ceilingHeight, predicted: pred.ceilingHeight, origin, missingExpected, flagged, ok };
}

/* ------------------------------ 치수 ------------------------------ */

interface Span {
  horizontal: boolean;
  lo: number;
  hi: number;
  perp: number;
}

function span(a: Pt, b: Pt): Span {
  const horizontal = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]);
  const k = horizontal ? 0 : 1;
  return { horizontal, lo: Math.min(a[k], b[k]), hi: Math.max(a[k], b[k]), perp: (a[1 - k] + b[1 - k]) / 2 };
}

function scoreDimensions(truth: TruthDimension[], pred: PredictedDimension[]): DimensionScore {
  const ts = truth.map((d) => span(d.a, d.b));
  const ps = pred.map((d) => span(d.a, d.b));
  const spanError = (i: number, j: number) => (ts[i].horizontal === ps[j].horizontal ? Math.max(Math.abs(ts[i].lo - ps[j].lo), Math.abs(ts[i].hi - ps[j].hi)) : Infinity);
  const matches = greedyMatch(truth.length, pred.length, (i, j) => {
    const e = spanError(i, j);
    // 같은 구간을 재는 치수가 양쪽 변에 있으면 치수선 위치가 가까운 쪽을 먼저 짝짓는다.
    return e <= T.dimensionSpan ? e + 0.01 * Math.abs(ts[i].perp - ps[j].perp) : null;
  });
  const label = (d: TruthDimension, i: number) => d.text ?? `#${i + 1}(${round(d.value)}m)`;
  const plabel = (d: PredictedDimension, j: number) => `${d.text || `#${j + 1}`}`;
  const valueOk = (stated: number | null, value: number) => stated !== null && Math.abs(stated - value) <= Math.max(T.dimensionValueAbs, T.dimensionValueRel * value);

  const valueErrors: string[] = [];
  const falseConflicts: string[] = [];
  let exact = 0;
  let conflictsDetected = 0;
  for (const [i, j] of matches) {
    const t = truth[i];
    const p = pred[j];
    if (valueOk(p.stated, t.value)) exact++;
    else valueErrors.push(label(t, i));
    if (t.conflict && p.status === "conflict") conflictsDetected++;
    if (!t.conflict && p.status === "conflict") falseConflicts.push(label(t, i));
  }
  const mi = new Set(matches.map((m) => m[0]));
  const mj = new Set(matches.map((m) => m[1]));
  const missedIdx = truth.map((_, i) => i).filter((i) => !mi.has(i));
  const extraIdx = pred.map((_, j) => j).filter((j) => !mj.has(j));
  const misattached = extraIdx.filter((j) => missedIdx.some((i) => valueOk(pred[j].stated, truth[i].value))).map((j) => plabel(pred[j], j));
  return {
    truth: truth.length,
    predicted: pred.length,
    linked: matches.length,
    exact,
    linkAccuracy: ratio(matches.length, truth.length),
    exactAccuracy: ratio(exact, truth.length),
    missed: missedIdx.map((i) => label(truth[i], i)),
    extra: extraIdx.map((j) => plabel(pred[j], j)),
    valueErrors,
    misattached,
    conflictsExpected: truth.filter((d) => d.conflict).length,
    conflictsDetected,
    falseConflicts,
  };
}

/* ------------------------------ 전체 ------------------------------ */

export function scoreFloorPlan(input: ScoreInput): FloorPlanScore {
  const { truth, predicted } = input;
  const dw = Math.abs(truth.envelope.width - predicted.envelope.width);
  const dd = Math.abs(truth.envelope.depth - predicted.envelope.depth);
  const frame =
    dw > T.frame || dd > T.frame
      ? {
          ok: false,
          message: `외곽 크기가 다릅니다(정답 ${truth.envelope.width} × ${truth.envelope.depth}m, 결과 ${predicted.envelope.width} × ${predicted.envelope.depth}m). 같은 보정 기준으로 만든 문서인지 확인하세요. 위치 오차에 보정 차이가 섞입니다.`,
        }
      : { ok: true };
  const walls = scoreWalls(truth, predicted);
  const openings = scoreOpenings(truth, predicted);
  const furniture = scoreFurniture(truth, predicted);
  const ceiling = scoreCeiling(truth, predicted, input.ceilingHeightMissing ?? false);
  const dimensions = input.truthDimensions ? scoreDimensions(input.truthDimensions, input.predictedDimensions ?? []) : null;
  const corrections = {
    walls: walls.corrections,
    openings: openings.corrections,
    furniture: furniture.corrections,
    ceiling: ceiling.ok ? 0 : 1,
    total: 0,
  };
  corrections.total = corrections.walls + corrections.openings + corrections.furniture + corrections.ceiling;
  return { tolerance: SCORE_TOLERANCE, frame, walls: walls.score, openings: openings.score, furniture: furniture.score, ceiling, dimensions, corrections };
}

/* ------------------------------ 표시 ------------------------------ */

const pct = (r: number | null) => (r === null ? "-" : `${Math.round(r * 1000) / 10}%`);
const m = (n: number | null) => (n === null ? "-" : `${n.toFixed(3)}m`);
const list = (name: string, ids: string[]) => (ids.length ? `    ${name}: ${ids.join(", ")}` : null);

/** 사람이 읽는 채점 요약(여러 줄) */
export function formatScore(s: FloorPlanScore): string {
  const lines: (string | null)[] = [];
  if (!s.frame.ok) lines.push(`  ⚠ ${s.frame.message}`);
  const det = (d: Detection) => `정답 ${d.truth} · 결과 ${d.predicted} · 일치 ${d.matched} · 재현율 ${pct(d.recall)} · 정밀도 ${pct(d.precision)}`;
  const w = s.walls;
  lines.push(`  벽      ${det(w)} · 길이 재현율 ${pct(w.lengthRecall)} · 길이 정밀도 ${pct(w.lengthPrecision)} · 끝점 오차 평균 ${m(w.endpointError.mean)}/최대 ${m(w.endpointError.max)}`);
  lines.push(list("누락", w.missed), list("오검출", w.extra), list("종류 다름", w.kindErrors), list("수정 필요", w.needsEdit));
  const o = s.openings;
  lines.push(`  개구부  ${det(o)} · 중심 오차 평균 ${m(o.centerError.mean)}/최대 ${m(o.centerError.max)} · 폭 오차 최대 ${m(o.widthError.max)} · 문 방향 비교 ${o.doorsCompared}개`);
  lines.push(
    list("누락", o.missed),
    list("오검출", o.extra),
    list("종류 다름", o.kindErrors),
    list("소속 벽 다름", o.hostErrors),
    list("경첩 다름", o.hingeErrors),
    list("열림 방향 다름", o.swingErrors),
    list("수정 필요", o.needsEdit),
  );
  const f = s.furniture;
  lines.push(`  가구    ${det(f)} · 중심 오차 평균 ${m(f.centerError.mean)}/최대 ${m(f.centerError.max)} · 크기 오차 최대 ${m(f.sizeError.max)}`);
  lines.push(list("누락", f.missed), list("오검출", f.extra), list("종류 다름", f.kindErrors), list("방향 다름", f.rotationErrors), list("수정 필요", f.needsEdit));
  const c = s.ceiling;
  lines.push(
    `  천장    ${c.ok ? "맞음" : "다름"} · ${c.missingExpected ? `표기 없음 → 누락 표시 ${c.flagged ? "있음" : "없음"}` : `정답 ${c.truth}m · 결과 ${c.predicted}m(출처 ${c.origin ?? "기록 없음"})`}`,
  );
  const d = s.dimensions;
  if (d) {
    lines.push(
      `  치수    정답 ${d.truth} · 결과 ${d.predicted} · 구간 연결 ${d.linked}(${pct(d.linkAccuracy)}) · 구간+값 정확 ${d.exact}(${pct(d.exactAccuracy)}) · 충돌 감지 ${d.conflictsDetected}/${d.conflictsExpected}`,
    );
    lines.push(list("누락", d.missed), list("오검출", d.extra), list("값 오독", d.valueErrors), list("다른 구간에 연결", d.misattached), list("잘못된 충돌 표시", d.falseConflicts));
  }
  const k = s.corrections;
  lines.push(`  추정 수정 수 ${k.total} (벽 ${k.walls} · 개구부 ${k.openings} · 가구 ${k.furniture} · 천장 ${k.ceiling})`);
  return lines.filter((l): l is string => l !== null).join("\n");
}
