import type { FloorPlanDocument, FloorPlanOpening, FloorPlanProvenance, FloorPlanWall } from "./schema";

/**
 * 도면 문서 편집 연산(순수 함수) + 실행 취소·다시 실행 기록.
 *
 * 모든 연산은 새 문서를 반환하고 원본을 바꾸지 않는다. 좌표는 도면 좌표(u, v, m)다.
 * 항목을 지우면 provenance·issues의 JSON Pointer 경로에서 해당 항목을 지우고 뒤 항목의 번호를 당긴다.
 * React·three.js에 의존하지 않으므로 Node 검증 스크립트에서 실행한다.
 */

export type Pt = [number, number];
export type WallKind = FloorPlanWall["kind"];
export type OpeningKind = FloorPlanOpening["kind"];

/* ------------------------------ 기본값 ------------------------------ */

/** 화면에 표시하는 기본값(실측값 아님). 사용자가 바꾸면 그 값이 남는다. */
export const EDITOR_DEFAULTS = {
  ceilingHeight: 2.8,
  envelopeWallThickness: 0.2,
  wallThickness: { solid: 0.12, glass: 0.08 } as Record<WallKind, number>,
  opening: {
    door: { width: 0.9, height: 2.1, bottom: 0 },
    window: { width: 1.2, height: 1.2, bottom: 0.9 },
    passage: { width: 0.9, height: 2.1, bottom: 0 },
  } as Record<OpeningKind, { width: number; height: number; bottom: number }>,
  door: { leaf: "paint", hinge: "start", swing: "pos", angle: 70 } as NonNullable<FloorPlanOpening["door"]>,
} as const;

/** mm 단위 반올림(편집 결과를 결정적으로 저장) */
export const mm = (n: number) => Math.round(n * 1000) / 1000 + 0;

/** 파일 이름 등에서 문서 ID를 만든다(영문·숫자·_·.·-, 영문·숫자로 시작, 64자 이하). */
export function toDocumentId(name: string, fallback = "plan"): string {
  const base = name
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 64)
    .replace(/[-.]+$/, "");
  return base || fallback;
}

export function createBlankDocument(opts: { id: string; title?: string; width: number; depth: number; ceilingHeight?: number }): FloorPlanDocument {
  return {
    schemaVersion: 1,
    id: opts.id,
    revision: 1,
    ...(opts.title ? { title: opts.title } : {}),
    unit: "m",
    envelope: { width: mm(opts.width), depth: mm(opts.depth), wallThickness: EDITOR_DEFAULTS.envelopeWallThickness },
    ceilingHeight: opts.ceilingHeight ?? EDITOR_DEFAULTS.ceilingHeight,
    walls: [],
    openings: [],
    furniture: [],
    source: { kind: "manual" },
    provenance: [
      { path: "/envelope/width", origin: "user", confirmed: true },
      { path: "/envelope/depth", origin: "user", confirmed: true },
      { path: "/envelope/wallThickness", origin: "default", confirmed: false, note: `도면 표기 없음. 기본값 ${EDITOR_DEFAULTS.envelopeWallThickness}m` },
      ...(opts.ceilingHeight === undefined
        ? [{ path: "/ceilingHeight", origin: "default" as const, confirmed: false, note: `도면에 높이 표기가 없어 기본값 ${EDITOR_DEFAULTS.ceilingHeight}m 사용` }]
        : [{ path: "/ceilingHeight", origin: "user" as const, confirmed: true }]),
    ],
    completeness: { walls: "unreviewed", openings: "unreviewed", furniture: "unreviewed" },
  };
}

/* ------------------------------ 실행 취소 기록 ------------------------------ */

export interface EditorState {
  doc: FloorPlanDocument;
  past: FloorPlanDocument[];
  future: FloorPlanDocument[];
  /** 불러온 뒤(또는 저장한 뒤) 바뀌었는지 */
  dirty: boolean;
}

export type EditorAction =
  | { type: "load"; doc: FloorPlanDocument }
  | { type: "apply"; update: (doc: FloorPlanDocument) => FloorPlanDocument }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "saved"; doc: FloorPlanDocument };

export const HISTORY_LIMIT = 100;

export function initEditor(doc: FloorPlanDocument): EditorState {
  return { doc, past: [], future: [], dirty: false };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "load":
      return initEditor(action.doc);
    case "apply": {
      const doc = action.update(state.doc);
      if (doc === state.doc) return state;
      return { doc, past: [...state.past, state.doc].slice(-HISTORY_LIMIT), future: [], dirty: true };
    }
    case "undo": {
      const prev = state.past.at(-1);
      if (!prev) return state;
      return { doc: prev, past: state.past.slice(0, -1), future: [state.doc, ...state.future], dirty: true };
    }
    case "redo": {
      const next = state.future[0];
      if (!next) return state;
      return { doc: next, past: [...state.past, state.doc], future: state.future.slice(1), dirty: true };
    }
    case "saved":
      // 저장(내보내기)한 문서를 기준으로 삼되 실행 취소 기록은 유지한다.
      return { ...state, doc: action.doc, dirty: false };
  }
}

/* ------------------------------ 벽 기하 ------------------------------ */

export interface WallGeom {
  id: string;
  start: Pt;
  end: Pt;
  exterior: boolean;
}

export const ENVELOPE_WALLS = ["north", "east", "south", "west"] as const;

/** 외곽 벽(진행 방향: 북 왼→오, 동 위→아래, 남 오→왼, 서 아래→위)과 내부 벽 */
export function wallGeoms(doc: FloorPlanDocument): WallGeom[] {
  const { width: W, depth: D } = doc.envelope;
  return [
    { id: "north", start: [0, 0], end: [W, 0], exterior: true },
    { id: "east", start: [W, 0], end: [W, D], exterior: true },
    { id: "south", start: [W, D], end: [0, D], exterior: true },
    { id: "west", start: [0, D], end: [0, 0], exterior: true },
    ...doc.walls.map((w) => ({ id: w.id, start: [...w.start] as Pt, end: [...w.end] as Pt, exterior: false })),
  ];
}

export const wallLength = (w: { start: Pt | readonly [number, number]; end: Pt | readonly [number, number] }) =>
  Math.hypot(w.end[0] - w.start[0], w.end[1] - w.start[1]);

export function findWall(doc: FloorPlanDocument, id: string): WallGeom | undefined {
  return wallGeoms(doc).find((w) => w.id === id);
}

/** 벽 위 거리 t의 점과 벽 방향 */
export function pointOnWall(w: WallGeom, t: number): { p: Pt; dir: Pt } {
  const len = wallLength(w) || 1;
  const dir: Pt = [(w.end[0] - w.start[0]) / len, (w.end[1] - w.start[1]) / len];
  return { p: [w.start[0] + dir[0] * t, w.start[1] + dir[1] * t], dir };
}

/** 점을 벽 선분에 투영(t는 시작점에서 거리, 0~길이로 제한) */
export function projectOnWall(w: WallGeom, p: Pt): { t: number; dist: number; foot: Pt } {
  const len = wallLength(w);
  if (len === 0) return { t: 0, dist: Math.hypot(p[0] - w.start[0], p[1] - w.start[1]), foot: [...w.start] };
  const dx = (w.end[0] - w.start[0]) / len;
  const dz = (w.end[1] - w.start[1]) / len;
  const t = Math.max(0, Math.min(len, (p[0] - w.start[0]) * dx + (p[1] - w.start[1]) * dz));
  const foot: Pt = [w.start[0] + dx * t, w.start[1] + dz * t];
  return { t, dist: Math.hypot(p[0] - foot[0], p[1] - foot[1]), foot };
}

/** 가장 가까운 벽(외곽 포함) */
export function nearestWall(doc: FloorPlanDocument, p: Pt, maxDist = Infinity): { wall: WallGeom; t: number; dist: number } | null {
  let best: { wall: WallGeom; t: number; dist: number } | null = null;
  for (const wall of wallGeoms(doc)) {
    const { t, dist } = projectOnWall(wall, p);
    if (dist <= maxDist && (!best || dist < best.dist)) best = { wall, t, dist };
  }
  return best;
}

/* ------------------------------ 맞춤(스냅) ------------------------------ */

export interface SnapOptions {
  /** 벽을 그리는 중이면 시작점(직교 고정 기준) */
  from?: Pt;
  /** 끝점·벽에 붙는 거리(m). 화면 확대율에 맞춰 호출하는 쪽이 정한다. */
  radius: number;
  /** 격자 간격(m). 0이면 격자 맞춤 없음 */
  grid: number;
  /** 움직이는 중인 벽(자기 끝점에 붙지 않게) */
  excludeWallId?: string;
  /** 직교 고정 허용 각도(도) */
  orthoDegrees?: number;
}

export type SnapKind = "endpoint" | "edge" | "ortho" | "grid" | "free";

/** 끝점 → 직교 고정 → 격자 → 벽 몸체 순으로 맞춘 뒤 외곽 안으로 제한한다. */
export function snapPoint(doc: FloorPlanDocument, raw: Pt, opts: SnapOptions): { point: Pt; kind: SnapKind } {
  const { width: W, depth: D } = doc.envelope;
  const clamp = (p: Pt): Pt => [mm(Math.min(W, Math.max(0, p[0]))), mm(Math.min(D, Math.max(0, p[1])))];
  const walls = wallGeoms(doc).filter((w) => w.id !== opts.excludeWallId);

  // 1) 끝점(내부 벽 끝점 + 외곽 모서리)
  let best: { p: Pt; d: number } | null = null;
  for (const w of walls) {
    for (const e of [w.start, w.end]) {
      const d = Math.hypot(e[0] - raw[0], e[1] - raw[1]);
      if (d <= opts.radius && (!best || d < best.d)) best = { p: e, d };
    }
  }
  if (best) return { point: clamp(best.p), kind: "endpoint" };

  // 2) 직교 고정
  let p: Pt = [...raw];
  let kind: SnapKind = "free";
  let lockU = false;
  let lockV = false;
  if (opts.from) {
    const dx = raw[0] - opts.from[0];
    const dz = raw[1] - opts.from[1];
    const tol = Math.tan(((opts.orthoDegrees ?? 8) * Math.PI) / 180);
    if (Math.abs(dz) <= Math.abs(dx) * tol) {
      p = [raw[0], opts.from[1]];
      lockV = true;
      kind = "ortho";
    } else if (Math.abs(dx) <= Math.abs(dz) * tol) {
      p = [opts.from[0], raw[1]];
      lockU = true;
      kind = "ortho";
    }
  }

  // 3) 격자(고정되지 않은 축만)
  if (opts.grid > 0) {
    const g = (n: number) => Math.round(n / opts.grid) * opts.grid;
    p = [lockU ? p[0] : g(p[0]), lockV ? p[1] : g(p[1])];
    if (kind === "free") kind = "grid";
  }

  // 4) 벽 몸체(T자 접합): 가까우면 벽 위로 투영
  let edge: { foot: Pt; dist: number } | null = null;
  for (const w of walls) {
    const { foot, dist } = projectOnWall(w, p);
    if (dist <= opts.radius && (!edge || dist < edge.dist)) edge = { foot, dist };
  }
  if (edge) return { point: clamp(edge.foot), kind: "edge" };
  return { point: clamp(p), kind };
}

/* ------------------------------ ID·경로 ------------------------------ */

function allIds(doc: FloorPlanDocument): Set<string> {
  return new Set<string>([
    ...ENVELOPE_WALLS,
    ...doc.walls.map((w) => w.id),
    ...doc.openings.map((o) => o.id),
    ...(doc.columns ?? []).map((c) => c.id),
    ...(doc.furniture ?? []).map((f) => f.id),
    ...(doc.zones ?? []).map((z) => z.id),
  ]);
}

/** prefix-1, prefix-2 … 중 쓰지 않은 ID */
export function nextId(doc: FloorPlanDocument, prefix: string): string {
  const used = allIds(doc);
  for (let n = 1; ; n++) if (!used.has(`${prefix}-${n}`)) return `${prefix}-${n}`;
}

type Collection = "walls" | "openings" | "furniture" | "columns" | "zones";

/** /collection/index 경로를 지우거나(그 항목과 하위) 뒤 번호를 하나씩 당긴다. null이면 삭제 대상 */
function shiftPointer(path: string, collection: Collection, index: number): string | null {
  const m = path.match(new RegExp(`^/${collection}/(\\d+)(/.*)?$`));
  if (!m) return path;
  const i = Number(m[1]);
  if (i === index) return null;
  return i > index ? `/${collection}/${i - 1}${m[2] ?? ""}` : path;
}

function removeAt(doc: FloorPlanDocument, collection: Collection, index: number): FloorPlanDocument {
  const list = (doc[collection] ?? []) as unknown[];
  const next = { ...doc, [collection]: list.filter((_, i) => i !== index) } as FloorPlanDocument;
  if (doc.provenance) {
    next.provenance = doc.provenance.flatMap((p) => {
      const path = shiftPointer(p.path, collection, index);
      return path === null ? [] : [{ ...p, path }];
    });
  }
  if (doc.issues) {
    next.issues = doc.issues.flatMap((s) => {
      if (!s.path) return [s];
      const path = shiftPointer(s.path, collection, index);
      return path === null ? [] : [{ ...s, path }];
    });
  }
  return next;
}

/** 같은 경로의 출처 기록을 바꾸거나 추가한다. */
export function setProvenance(doc: FloorPlanDocument, entry: FloorPlanProvenance): FloorPlanDocument {
  const list = doc.provenance ?? [];
  const i = list.findIndex((p) => p.path === entry.path);
  return { ...doc, provenance: i < 0 ? [...list, entry] : list.map((p, k) => (k === i ? entry : p)) };
}

/** 경로(와 하위 경로)의 출처를 사용자 확인으로 표시 */
export function confirmPath(doc: FloorPlanDocument, path: string): FloorPlanDocument {
  if (!doc.provenance?.some((p) => !p.confirmed && (p.path === path || p.path.startsWith(`${path}/`)))) return doc;
  return { ...doc, provenance: doc.provenance.map((p) => (p.path === path || p.path.startsWith(`${path}/`) ? { ...p, confirmed: true } : p)) };
}

/* ------------------------------ 외곽·높이 ------------------------------ */

export function setEnvelope(doc: FloorPlanDocument, patch: Partial<FloorPlanDocument["envelope"]>): FloorPlanDocument {
  let next: FloorPlanDocument = { ...doc, envelope: { ...doc.envelope, ...patch } };
  for (const key of Object.keys(patch) as (keyof FloorPlanDocument["envelope"])[]) {
    next = setProvenance(next, { path: `/envelope/${key}`, origin: "user", confirmed: true });
  }
  return next;
}

export function setCeilingHeight(doc: FloorPlanDocument, height: number): FloorPlanDocument {
  return setProvenance({ ...doc, ceilingHeight: height }, { path: "/ceilingHeight", origin: "user", confirmed: true });
}

export function setCompleteness(doc: FloorPlanDocument, key: "walls" | "openings" | "furniture", value: "reviewed" | "unreviewed"): FloorPlanDocument {
  const base = doc.completeness ?? { walls: "unreviewed", openings: "unreviewed", furniture: "unreviewed" };
  return { ...doc, completeness: { ...base, [key]: value } };
}

/* ------------------------------ 벽 ------------------------------ */

export function addWall(doc: FloorPlanDocument, start: Pt, end: Pt, kind: WallKind = "solid"): { doc: FloorPlanDocument; id: string } {
  const id = nextId(doc, "wall");
  const wall: FloorPlanWall = { id, kind, start: [mm(start[0]), mm(start[1])], end: [mm(end[0]), mm(end[1])], thickness: EDITOR_DEFAULTS.wallThickness[kind] };
  const next = setProvenance({ ...doc, walls: [...doc.walls, wall] }, { path: `/walls/${doc.walls.length}`, origin: "user", confirmed: true });
  return { doc: next, id };
}

export function updateWall(doc: FloorPlanDocument, id: string, patch: Partial<Omit<FloorPlanWall, "id">>): FloorPlanDocument {
  const i = doc.walls.findIndex((w) => w.id === id);
  if (i < 0) return doc;
  const cur = doc.walls[i];
  const wall: FloorPlanWall = { ...cur, ...patch };
  // 종류만 바꾸고 두께가 그 종류의 기본값이었으면 새 종류의 기본값으로 바꾼다.
  if (patch.kind && patch.thickness === undefined && cur.thickness === EDITOR_DEFAULTS.wallThickness[cur.kind]) {
    wall.thickness = EDITOR_DEFAULTS.wallThickness[patch.kind];
  }
  if (patch.start) wall.start = [mm(patch.start[0]), mm(patch.start[1])];
  if (patch.end) wall.end = [mm(patch.end[0]), mm(patch.end[1])];
  const next = { ...doc, walls: doc.walls.map((w, k) => (k === i ? wall : w)) };
  return setProvenance(next, { path: `/walls/${i}`, origin: "user", confirmed: true });
}

/** 벽 전체 이동(외곽 안으로 제한). 개구부는 시작점 기준 거리라 함께 움직인다. */
export function translateWall(doc: FloorPlanDocument, id: string, du: number, dv: number): FloorPlanDocument {
  const w = doc.walls.find((x) => x.id === id);
  if (!w) return doc;
  const { width: W, depth: D } = doc.envelope;
  const minU = Math.min(w.start[0], w.end[0]);
  const maxU = Math.max(w.start[0], w.end[0]);
  const minV = Math.min(w.start[1], w.end[1]);
  const maxV = Math.max(w.start[1], w.end[1]);
  const cu = Math.max(-minU, Math.min(W - maxU, du));
  const cv = Math.max(-minV, Math.min(D - maxV, dv));
  return updateWall(doc, id, { start: [w.start[0] + cu, w.start[1] + cv], end: [w.end[0] + cu, w.end[1] + cv] });
}

/** 벽과 그 벽의 개구부를 지운다. */
export function deleteWall(doc: FloorPlanDocument, id: string): FloorPlanDocument {
  let next = doc;
  for (let i = next.openings.length - 1; i >= 0; i--) if (next.openings[i].wallId === id) next = removeAt(next, "openings", i);
  const i = next.walls.findIndex((w) => w.id === id);
  return i < 0 ? next : removeAt(next, "walls", i);
}

/* ------------------------------ 개구부 ------------------------------ */

/** 벽 위에 들어가도록 중심 거리를 제한한다. */
export function clampOffset(wallLen: number, width: number, offset: number): number {
  if (width >= wallLen) return mm(wallLen / 2);
  return mm(Math.min(wallLen - width / 2, Math.max(width / 2, offset)));
}

export function addOpening(doc: FloorPlanDocument, wallId: string, kind: OpeningKind, offset: number): { doc: FloorPlanDocument; id: string } | null {
  const wall = findWall(doc, wallId);
  // 내부 벽의 창은 단기 지원 범위 밖(내부 벽은 바닥에 닿는 문·통로만)
  if (!wall || (kind === "window" && !wall.exterior)) return null;
  const len = wallLength(wall);
  const d = EDITOR_DEFAULTS.opening[kind];
  const width = mm(Math.min(d.width, len * 0.9));
  const height = Math.min(d.height, doc.ceilingHeight - d.bottom - 0.05);
  const id = nextId(doc, kind);
  const opening: FloorPlanOpening = {
    id,
    wallId,
    kind,
    offset: clampOffset(len, width, offset),
    width,
    height: mm(height),
    bottom: d.bottom,
    ...(kind === "door" ? { door: { ...EDITOR_DEFAULTS.door } } : {}),
  };
  const next = setProvenance({ ...doc, openings: [...doc.openings, opening] }, { path: `/openings/${doc.openings.length}`, origin: "user", confirmed: true });
  return { doc: next, id };
}

export function updateOpening(doc: FloorPlanDocument, id: string, patch: Partial<Omit<FloorPlanOpening, "id">>): FloorPlanDocument {
  const i = doc.openings.findIndex((o) => o.id === id);
  if (i < 0) return doc;
  const cur = doc.openings[i];
  let o: FloorPlanOpening = { ...cur, ...patch };
  // 종류를 바꾸면 문짝·하단 높이를 그 종류의 규칙에 맞춘다.
  if (patch.kind && patch.kind !== cur.kind) {
    const d = EDITOR_DEFAULTS.opening[patch.kind];
    o = { ...o, bottom: patch.bottom ?? d.bottom, height: patch.height ?? Math.min(d.height, doc.ceilingHeight - d.bottom - 0.05) };
    if (patch.kind === "door") o.door = o.door ?? { ...EDITOR_DEFAULTS.door };
    else delete o.door;
  }
  for (const k of ["offset", "width", "height", "bottom"] as const) o[k] = mm(o[k]);
  const next = { ...doc, openings: doc.openings.map((x, k) => (k === i ? o : x)) };
  return setProvenance(next, { path: `/openings/${i}`, origin: "user", confirmed: true });
}

/** 개구부를 벽 위에서 옮긴다(벽 범위 안으로 제한). 다른 벽 위로 옮기면 소속 벽을 바꾼다. */
export function moveOpening(doc: FloorPlanDocument, id: string, wallId: string, offset: number): FloorPlanDocument {
  const o = doc.openings.find((x) => x.id === id);
  const wall = findWall(doc, wallId);
  if (!o || !wall) return doc;
  const len = wallLength(wall);
  if (o.kind === "window" && !wall.exterior) return doc; // 내부 벽 창은 단기 지원 범위 밖
  return updateOpening(doc, id, { wallId, offset: clampOffset(len, Math.min(o.width, len), offset) });
}

export function deleteOpening(doc: FloorPlanDocument, id: string): FloorPlanDocument {
  const i = doc.openings.findIndex((o) => o.id === id);
  return i < 0 ? doc : removeAt(doc, "openings", i);
}

/* ------------------------------ 가구 ------------------------------ */

export function deleteFurniture(doc: FloorPlanDocument, id: string): FloorPlanDocument {
  const i = (doc.furniture ?? []).findIndex((f) => f.id === id);
  return i < 0 ? doc : removeAt(doc, "furniture", i);
}

/* ------------------------------ 저장 ------------------------------ */

/**
 * 내보낼 문서. 불러온 뒤 바뀌었으면 revision을 1 올린다(같은 id의 수정본 구분).
 * 편집기 전용 정보는 문서에 없으므로 그대로 직렬화한다.
 */
export function documentForExport(doc: FloorPlanDocument, changed: boolean): FloorPlanDocument {
  return changed ? { ...doc, revision: doc.revision + 1 } : doc;
}

export const exportFileName = (doc: FloorPlanDocument) => `${doc.id}-r${doc.revision}.json`;
