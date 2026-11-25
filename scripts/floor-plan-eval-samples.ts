/**
 * 합성 평가 사례(단기 계획 S5) — 정답 문서에서 축척이 정확한 평면도 이미지를 그려 정답이 확실한 사례를 만든다.
 * 실제 대상 도면을 대신하지 않는다. 채점·실행 흐름 확인과 모델 간 기준 비교(깨끗한 도면·높이 미표기·치수 충돌·저품질)에 쓴다.
 *
 * 사례마다 만드는 파일(examples/floor-plans/eval/<id>/):
 *   plan.png|jpg         정답 문서를 그린 도면(외벽·내부 벽·유리 칸막이·문·창·통로·기둥·가구·치수선)
 *   base.json            보정만 적용한 문서(상단·좌측 전체 치수를 기준 구간으로 사용)
 *   truth.json           정답 문서
 *   fake-extraction.json 정답을 그대로 읽은 "완벽한 모델" 응답(키 없이 실행기·채점기 확인용)
 *   case.json            사례 정보와 정답 치수
 * 생성: npm run eval:samples (결정적. 같은 입력이면 같은 JSON)
 */
import path from "node:path";
import sharp from "sharp";
import { AI_FURNITURE_KINDS, type FloorPlanExtraction } from "../src/lib/floorPlan/ai/extraction";
import { applyCalibration } from "../src/lib/floorPlan/calibration";
import { mm, pointOnWall, wallGeoms, type Pt } from "../src/lib/floorPlan/editor";
import type { FloorPlanDocument } from "../src/lib/floorPlan/schema";
import type { EvalCase } from "./floor-plan-eval";
import { EVAL_DIR } from "./floor-plan-eval";
import { EXAMPLES_DIR, toJsonText } from "./floor-plan-files";
import { buildOfficeFloorPlanDocument } from "./floor-plan-office";
import { readFileSync } from "node:fs";

type Side = "top" | "bottom" | "left" | "right";

interface SampleSpec {
  id: string;
  description: string;
  categories: EvalCase["categories"];
  source: FloorPlanDocument;
  /** 그릴 때 배율(px/m) */
  pxPerM: number;
  /** 정답 천장 높이. null이면 도면에 표기하지 않는다(문서 값은 원본 유지). */
  ceilingText: { height: number; at: Pt } | null;
  /** 치수 하나를 기하와 다르게 적는다(측, 부분 치수 순번, 적을 값 mm) */
  conflict?: { side: Side; index: number; textMm: number };
  /** 저품질: 그린 뒤 축소·흐림·JPEG 압축 */
  lowQuality?: { factor: number; blur: number; quality: number };
}

interface DimLine {
  side: Side;
  role: "part" | "total";
  value: number;
  text: string;
  /** 치수선 위 양 끝(도면 m) */
  a: Pt;
  b: Pt;
}

const SCHEMA_REF = "../../../../schemas/floor-plan-document.v1.schema.json";

function studioSource(): FloorPlanDocument {
  return JSON.parse(readFileSync(path.join(EXAMPLES_DIR, "small-studio.json"), "utf8")) as FloorPlanDocument;
}

export function sampleSpecs(): SampleSpec[] {
  const studioCh = { height: 2.6, at: [2.3, 0.9] as Pt };
  return [
    {
      id: "studio-clean",
      description: "합성: 소형 원룸(5×4m) 깨끗한 축척 도면. 천장 높이 표기 있음.",
      categories: ["clean"],
      source: studioSource(),
      pxPerM: 100,
      ceilingText: studioCh,
    },
    {
      id: "studio-conflict",
      description: "합성: 소형 원룸. 상단 연속 치수 하나를 실제(3,200)와 다르게 3,600으로 적음 → 치수 충돌·합계 불일치.",
      categories: ["dimension-conflict"],
      source: studioSource(),
      pxPerM: 100,
      ceilingText: studioCh,
      conflict: { side: "top", index: 0, textMm: 3600 },
    },
    {
      id: "studio-lowres",
      description: "합성: 소형 원룸을 절반 크기로 줄이고 흐리게 한 저품질 JPEG(약 50px/m).",
      categories: ["low-quality"],
      source: studioSource(),
      pxPerM: 100,
      ceilingText: studioCh,
      lowQuality: { factor: 0.5, blur: 0.7, quality: 45 },
    },
    {
      id: "office-noheight",
      description: "합성: 사무실(18×8m, 가구 47개·기둥 3개) 축척 도면. 천장 높이 표기 없음.",
      categories: ["clean", "missing-height"],
      source: buildOfficeFloorPlanDocument(),
      pxPerM: 70,
      ceilingText: null,
    },
  ];
}

/* ------------------------------ 기하 ------------------------------ */

const EPS = 1e-6;
const r1 = (n: number) => Math.round(n * 10) / 10 + 0;

/** 내부 벽이 닿는 위치로 각 변을 나눈 연속 치수와 전체 치수(상단·좌측) */
function dimensionLines(doc: FloorPlanDocument, spec: SampleSpec): DimLine[] {
  const { width: W, depth: D, wallThickness: t } = doc.envelope;
  const vertical = doc.walls.filter((w) => Math.abs(w.start[0] - w.end[0]) < EPS);
  const horizontal = doc.walls.filter((w) => Math.abs(w.start[1] - w.end[1]) < EPS);
  const cuts = (xs: number[], max: number) => [...new Set([0, ...xs.map(mm), max])].sort((p, q) => p - q);
  const sides: Record<Side, number[]> = {
    top: cuts(vertical.filter((w) => Math.min(w.start[1], w.end[1]) < EPS).map((w) => w.start[0]), W),
    bottom: cuts(vertical.filter((w) => Math.max(w.start[1], w.end[1]) > D - EPS).map((w) => w.start[0]), W),
    left: cuts(horizontal.filter((w) => Math.min(w.start[0], w.end[0]) < EPS).map((w) => w.start[1]), D),
    right: cuts(horizontal.filter((w) => Math.max(w.start[0], w.end[0]) > W - EPS).map((w) => w.start[1]), D),
  };
  const row1 = t + 0.5;
  const row2 = t + 1.0;
  const at = (side: Side, row: number, from: number, to: number): [Pt, Pt] => {
    switch (side) {
      case "top":
        return [
          [from, -row],
          [to, -row],
        ];
      case "bottom":
        return [
          [from, D + row],
          [to, D + row],
        ];
      case "left":
        return [
          [-row, from],
          [-row, to],
        ];
      case "right":
        return [
          [W + row, from],
          [W + row, to],
        ];
    }
  };
  const out: DimLine[] = [];
  for (const side of ["top", "left", "bottom", "right"] as Side[]) {
    const c = sides[side];
    const hasParts = c.length > 2;
    if (hasParts) {
      for (let i = 0; i < c.length - 1; i++) {
        const value = mm(c[i + 1] - c[i]);
        const conflict = spec.conflict && spec.conflict.side === side && spec.conflict.index === i;
        const [a, b] = at(side, row1, c[i], c[i + 1]);
        out.push({ side, role: "part", value, text: String(conflict ? spec.conflict!.textMm : Math.round(value * 1000)), a, b });
      }
    }
    if (side === "top" || side === "left") {
      const max = c[c.length - 1];
      const [a, b] = at(side, hasParts ? row2 : row1, 0, max);
      out.push({ side, role: "total", value: max, text: String(Math.round(max * 1000)), a, b });
    }
  }
  return out;
}

interface OpeningDraw {
  kind: "door" | "window" | "passage";
  /** 벽 중심선 위 개구부 중심 */
  center: Pt;
  dir: Pt;
  width: number;
  thickness: number;
  /** 문: 경첩 문설주(중심선 위), 열림 쪽 법선 */
  hinge: Pt | null;
  other: Pt | null;
  swing: Pt | null;
  /** 벽 진행 방향 시작 쪽이 경첩인지 */
  hingeAtStart: boolean;
}

function openingDraws(doc: FloorPlanDocument): OpeningDraw[] {
  const t = doc.envelope.wallThickness;
  const walls = new Map(wallGeoms(doc).map((w) => [w.id, w]));
  const thick = new Map(doc.walls.map((w) => [w.id, w.thickness]));
  return doc.openings.flatMap((o) => {
    const w = walls.get(o.wallId);
    if (!w) return [];
    const { p, dir } = pointOnWall(w, o.offset);
    const n: Pt = [-dir[1], dir[0]]; // pos 법선(외곽 벽에서는 실내 쪽)
    // 외곽 벽 기준선은 실내 마감면이므로 벽 중심선은 바깥쪽으로 두께의 절반
    const center: Pt = w.exterior ? [p[0] - (n[0] * t) / 2, p[1] - (n[1] * t) / 2] : p;
    const thickness = w.exterior ? t : (thick.get(w.id) ?? 0.12);
    const half = o.width / 2;
    const s: Pt = [center[0] - dir[0] * half, center[1] - dir[1] * half];
    const e: Pt = [center[0] + dir[0] * half, center[1] + dir[1] * half];
    const door = o.kind === "door" ? o.door : undefined;
    const hingeAtStart = door ? door.hinge === "start" : true;
    return [
      {
        kind: o.kind,
        center,
        dir,
        width: o.width,
        thickness,
        hinge: door ? (hingeAtStart ? s : e) : null,
        other: door ? (hingeAtStart ? e : s) : null,
        swing: door ? (door.swing === "pos" ? n : ([-n[0], -n[1]] as Pt)) : null,
        hingeAtStart,
      },
    ];
  });
}

/** 회전을 반영한 축 정렬 바닥 영역 크기 */
function extent(size: readonly number[], rotation: number): Pt {
  const r = (rotation * Math.PI) / 180;
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  return [size[0] * c + size[2] * s, size[0] * s + size[2] * c];
}

function facingOf(rotation: number): "down" | "right" | "up" | "left" {
  const r = ((((rotation + 180) % 360) + 360) % 360) - 180; // (-180, 180]
  const options: [number, "down" | "right" | "up" | "left"][] = [
    [0, "down"],
    [90, "right"],
    [180, "up"],
    [-180, "up"],
    [-90, "left"],
  ];
  return options.reduce((best, o) => (Math.abs(o[0] - r) < Math.abs(best[0] - r) ? o : best))[1];
}

/* ------------------------------ 그리기 ------------------------------ */

const LABELS: Partial<Record<string, string>> = {
  sofa: "SOFA",
  armchair: "ARMCHAIR",
  coffeeTable: "TABLE",
  sideTable: "SIDE",
  tvConsole: "TV UNIT",
  bookshelf: "SHELF",
  plant: "PLANT",
  rug: "RUG",
  conferenceTable: "CONF. TABLE",
  hDesk: "H-DESK",
  roundMeetingTable: "TABLE",
  bench: "BENCH",
  lowCabinet: "CABINET",
  pantryCounter: "PANTRY",
  unknown: "DESK",
};
const SEATING = new Set(["sofa", "armchair", "meetingChair", "officeChair"]);
const ROUND = new Set(["plant", "roundMeetingTable"]);

interface Layout {
  s: number;
  ox: number;
  oy: number;
  width: number;
  height: number;
}

function layoutOf(doc: FloorPlanDocument, s: number): Layout {
  const margin = Math.round((doc.envelope.wallThickness + 1.5) * s);
  return {
    s,
    ox: margin,
    oy: margin,
    width: Math.round(doc.envelope.width * s) + margin * 2,
    height: Math.round(doc.envelope.depth * s) + margin * 2 + Math.round(0.5 * s),
  };
}

function renderSvg(doc: FloorPlanDocument, spec: SampleSpec, dims: DimLine[], L: Layout): string {
  const { s, ox, oy } = L;
  const X = (u: number) => r1(ox + u * s);
  const Y = (v: number) => r1(oy + v * s);
  const P = (p: Pt) => `${X(p[0])},${Y(p[1])}`;
  const { width: W, depth: D, wallThickness: t } = doc.envelope;
  const ink = "#2f2f2f";
  const font = "DejaVu Sans, Arial, Helvetica, sans-serif";
  const fsDim = Math.max(11, Math.min(15, Math.round(0.16 * s)));
  const fsLabel = Math.max(9, Math.min(13, Math.round(0.13 * s)));
  const el: string[] = [];
  el.push(`<rect width="${L.width}" height="${L.height}" fill="#ffffff"/>`);

  // 외벽
  el.push(
    `<path fill="${ink}" fill-rule="evenodd" d="M${X(-t)},${Y(-t)} H${X(W + t)} V${Y(D + t)} H${X(-t)} Z M${X(0)},${Y(0)} H${X(W)} V${Y(D)} H${X(0)} Z"/>`,
  );
  // 내부 벽
  for (const w of doc.walls) {
    if (w.kind === "solid") {
      el.push(`<line x1="${X(w.start[0])}" y1="${Y(w.start[1])}" x2="${X(w.end[0])}" y2="${Y(w.end[1])}" stroke="${ink}" stroke-width="${r1(w.thickness * s)}"/>`);
    } else {
      const len = Math.hypot(w.end[0] - w.start[0], w.end[1] - w.start[1]);
      const d: Pt = [(w.end[0] - w.start[0]) / len, (w.end[1] - w.start[1]) / len];
      const h = Math.max(w.thickness, 4 / s) / 2;
      const n: Pt = [-d[1] * h, d[0] * h];
      const pts: Pt[] = [
        [w.start[0] + n[0], w.start[1] + n[1]],
        [w.end[0] + n[0], w.end[1] + n[1]],
        [w.end[0] - n[0], w.end[1] - n[1]],
        [w.start[0] - n[0], w.start[1] - n[1]],
      ];
      el.push(`<polygon points="${pts.map(P).join(" ")}" fill="#dbeefa" stroke="#2b7bb9" stroke-width="1"/>`);
      el.push(`<line x1="${X(w.start[0])}" y1="${Y(w.start[1])}" x2="${X(w.end[0])}" y2="${Y(w.end[1])}" stroke="#2b7bb9" stroke-width="0.8"/>`);
    }
  }
  // 기둥
  for (const c of doc.columns ?? []) {
    el.push(`<rect x="${X(c.center[0] - c.size[0] / 2)}" y="${Y(c.center[1] - c.size[1] / 2)}" width="${r1(c.size[0] * s)}" height="${r1(c.size[1] * s)}" fill="#444"/>`);
  }
  // 개구부
  for (const o of openingDraws(doc)) {
    const half = o.width / 2;
    const th = o.thickness / 2 + 1 / s;
    const n: Pt = [-o.dir[1], o.dir[0]];
    const corner = (a: number, b: number): Pt => [o.center[0] + o.dir[0] * a + n[0] * b, o.center[1] + o.dir[1] * a + n[1] * b];
    el.push(`<polygon points="${[corner(-half, -th), corner(half, -th), corner(half, th), corner(-half, th)].map(P).join(" ")}" fill="#ffffff"/>`);
    const tj = o.thickness / 2;
    for (const a of [-half, half]) el.push(`<line x1="${X(corner(a, -tj)[0])}" y1="${Y(corner(a, -tj)[1])}" x2="${X(corner(a, tj)[0])}" y2="${Y(corner(a, tj)[1])}" stroke="${ink}" stroke-width="1.5"/>`);
    if (o.kind === "window") {
      for (const b of [-tj, 0, tj]) el.push(`<line x1="${X(corner(-half, b)[0])}" y1="${Y(corner(-half, b)[1])}" x2="${X(corner(half, b)[0])}" y2="${Y(corner(half, b)[1])}" stroke="${ink}" stroke-width="1"/>`);
    } else if (o.kind === "door" && o.hinge && o.other && o.swing) {
      const tip: Pt = [o.hinge[0] + o.swing[0] * o.width, o.hinge[1] + o.swing[1] * o.width];
      el.push(`<line x1="${X(o.hinge[0])}" y1="${Y(o.hinge[1])}" x2="${X(tip[0])}" y2="${Y(tip[1])}" stroke="${ink}" stroke-width="2"/>`);
      const v1: Pt = [tip[0] - o.hinge[0], tip[1] - o.hinge[1]];
      const v2: Pt = [o.other[0] - o.hinge[0], o.other[1] - o.hinge[1]];
      const sweep = v1[0] * v2[1] - v1[1] * v2[0] > 0 ? 1 : 0;
      el.push(`<path d="M${P(tip)} A${r1(o.width * s)},${r1(o.width * s)} 0 0 ${sweep} ${P(o.other)}" fill="none" stroke="${ink}" stroke-width="0.8"/>`);
    }
  }
  // 가구
  for (const f of doc.furniture ?? []) {
    const [w, , d] = f.size;
    const rot = f.rotation ?? 0;
    const g: string[] = [];
    if (ROUND.has(f.kind)) {
      g.push(`<circle cx="0" cy="0" r="${r1((Math.min(w, d) * s) / 2)}" fill="#f1f1f1" stroke="#555" stroke-width="1.2"/>`);
    } else {
      g.push(`<rect x="${r1((-w * s) / 2)}" y="${r1((-d * s) / 2)}" width="${r1(w * s)}" height="${r1(d * s)}" fill="#f1f1f1" stroke="#555" stroke-width="1.2"/>`);
      if (SEATING.has(f.kind)) {
        // 등받이(뒤쪽 = 정면의 반대)
        g.push(`<rect x="${r1((-w * s) / 2)}" y="${r1((-d * s) / 2)}" width="${r1(w * s)}" height="${r1(Math.max(3, d * s * 0.22))}" fill="#bdbdbd" stroke="#555" stroke-width="1"/>`);
      }
    }
    el.push(`<g transform="translate(${X(f.position[0])},${Y(f.position[2])}) rotate(${-rot})">${g.join("")}</g>`);
    const label = LABELS[f.kind];
    const ext = extent(f.size, rot);
    if (label && label.length * fsLabel * 0.62 < ext[0] * s - 4 && fsLabel + 2 < ext[1] * s) {
      el.push(`<text x="${X(f.position[0])}" y="${r1(Y(f.position[2]) + fsLabel * 0.35)}" font-family="${font}" font-size="${fsLabel}" text-anchor="middle" fill="#333">${label}</text>`);
    }
  }
  // 치수선
  const tick = 6;
  for (const dl of dims) {
    const horizontal = dl.side === "top" || dl.side === "bottom";
    el.push(`<line x1="${X(dl.a[0])}" y1="${Y(dl.a[1])}" x2="${X(dl.b[0])}" y2="${Y(dl.b[1])}" stroke="#555" stroke-width="1"/>`);
    for (const p of [dl.a, dl.b]) {
      el.push(`<line x1="${r1(X(p[0]) - tick)}" y1="${r1(Y(p[1]) + tick)}" x2="${r1(X(p[0]) + tick)}" y2="${r1(Y(p[1]) - tick)}" stroke="#555" stroke-width="1.2"/>`);
      // 보조선: 외벽 바깥면에서 치수선 조금 너머까지
      if (horizontal) {
        const from = dl.side === "top" ? -t - 0.05 : D + t + 0.05;
        const to = dl.side === "top" ? p[1] - 0.1 : p[1] + 0.1;
        el.push(`<line x1="${X(p[0])}" y1="${Y(from)}" x2="${X(p[0])}" y2="${Y(to)}" stroke="#888" stroke-width="0.6"/>`);
      } else {
        const from = dl.side === "left" ? -t - 0.05 : W + t + 0.05;
        const to = dl.side === "left" ? p[0] - 0.1 : p[0] + 0.1;
        el.push(`<line x1="${X(from)}" y1="${Y(p[1])}" x2="${X(to)}" y2="${Y(p[1])}" stroke="#888" stroke-width="0.6"/>`);
      }
    }
    const mid: Pt = [(dl.a[0] + dl.b[0]) / 2, (dl.a[1] + dl.b[1]) / 2];
    if (horizontal) {
      const y = dl.side === "top" ? Y(mid[1]) - 4 : Y(mid[1]) + fsDim + 2;
      el.push(`<text x="${X(mid[0])}" y="${r1(y)}" font-family="${font}" font-size="${fsDim}" text-anchor="middle" fill="#222">${dl.text}</text>`);
    } else {
      const x = dl.side === "left" ? X(mid[0]) - 4 : X(mid[0]) + fsDim + 2;
      el.push(`<text transform="translate(${r1(x)},${Y(mid[1])}) rotate(-90)" font-family="${font}" font-size="${fsDim}" text-anchor="middle" fill="#222">${dl.text}</text>`);
    }
  }
  if (spec.ceilingText) {
    const c = spec.ceilingText;
    el.push(`<text x="${X(c.at[0])}" y="${Y(c.at[1])}" font-family="${font}" font-size="${fsDim}" text-anchor="middle" fill="#222">CH ${Math.round(c.height * 1000)}</text>`);
  }
  el.push(`<text x="${ox}" y="${L.height - Math.round(0.25 * s)}" font-family="${font}" font-size="${fsDim}" fill="#444">SYNTHETIC SAMPLE ${spec.id.toUpperCase()} · UNIT: mm</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${L.width}" height="${L.height}" viewBox="0 0 ${L.width} ${L.height}">${el.join("")}</svg>`;
}

/* ------------------------------ 사례 파일 ------------------------------ */

function truthDocument(spec: SampleSpec): FloorPlanDocument {
  const src = spec.source;
  return {
    $schema: SCHEMA_REF,
    schemaVersion: 1,
    id: `${spec.id}-truth`,
    revision: 1,
    title: `${spec.id} 정답`,
    unit: "m",
    envelope: { ...src.envelope },
    ceilingHeight: spec.ceilingText?.height ?? src.ceilingHeight,
    walls: src.walls,
    openings: src.openings,
    ...(src.columns ? { columns: src.columns } : {}),
    furniture: src.furniture ?? [],
  };
}

function fakeExtraction(truth: FloorPlanDocument, spec: SampleSpec, dims: DimLine[], L: Layout, k: number): FloorPlanExtraction {
  const { s, ox, oy } = L;
  const px = (p: Pt) => ({ x: r1((ox + p[0] * s) * k), y: r1((oy + p[1] * s) * k) });
  const { width: W, depth: D, wallThickness: t } = truth.envelope;
  const aiKinds = new Set<string>(AI_FURNITURE_KINDS);
  return {
    readable: true,
    planBox: { x0: 0, y0: 0, x1: r1(L.width * k), y1: r1((L.height - 0.5 * s) * k) },
    envelope: { ...cornerBox(px([0, 0]), px([W, D])) },
    outerWallThicknessPx: r1(t * s * k),
    walls: truth.walls.map((w) => ({ kind: w.kind, a: px(w.start), b: px(w.end), thicknessPx: r1(w.thickness * s * k), confidence: 0.9 })),
    openings: openingDraws(truth).map((o) => {
      const half = o.width / 2;
      const a: Pt = [o.center[0] - o.dir[0] * half, o.center[1] - o.dir[1] * half];
      const b: Pt = [o.center[0] + o.dir[0] * half, o.center[1] + o.dir[1] * half];
      const toward: Pt | null =
        o.hinge && o.other && o.swing
          ? [o.hinge[0] + (o.other[0] - o.hinge[0]) * 0.5 + o.swing[0] * o.width * 0.5, o.hinge[1] + (o.other[1] - o.hinge[1]) * 0.5 + o.swing[1] * o.width * 0.5]
          : null;
      return {
        kind: o.kind,
        a: px(a),
        b: px(b),
        hinge: o.kind === "door" ? (o.hingeAtStart ? "a" : "b") : null,
        swingToward: toward ? px(toward) : null,
        confidence: 0.9,
      };
    }),
    furniture: (truth.furniture ?? []).map((f) => {
      const e = extent(f.size, f.rotation ?? 0);
      const c: Pt = [f.position[0], f.position[2]];
      return {
        kind: (aiKinds.has(f.kind) ? f.kind : "unknown") as FloorPlanExtraction["furniture"][number]["kind"],
        label: f.label ?? null,
        box: cornerBox(px([c[0] - e[0] / 2, c[1] - e[1] / 2]), px([c[0] + e[0] / 2, c[1] + e[1] / 2])),
        facing: ROUND.has(f.kind) ? null : facingOf(f.rotation ?? 0),
        confidence: 0.9,
      };
    }),
    dimensions: dims.map((d) => ({ text: d.text, value: Number(d.text), unit: null, a: px(d.a), b: px(d.b), chain: d.side, role: d.role })),
    ceilingHeight: spec.ceilingText ? { text: `CH ${Math.round(spec.ceilingText.height * 1000)}`, value: Math.round(spec.ceilingText.height * 1000), unit: null } : null,
    unsupported: [],
    notes: [],
  };
}

const cornerBox = (p: { x: number; y: number }, q: { x: number; y: number }) => ({ x0: Math.min(p.x, q.x), y0: Math.min(p.y, q.y), x1: Math.max(p.x, q.x), y1: Math.max(p.y, q.y) });

/** 생성 파일 목록 [경로, 내용]. 이미지는 Buffer, 나머지는 JSON 문자열. */
export async function buildEvalSamples(): Promise<[string, string | Buffer][]> {
  const files: [string, string | Buffer][] = [];
  for (const spec of sampleSpecs()) {
    const dir = path.join(EVAL_DIR, spec.id);
    const truth = truthDocument(spec);
    const dims = dimensionLines(truth, spec);
    const L = layoutOf(truth, spec.pxPerM);
    const svg = renderSvg(truth, spec, dims, L);
    const k = spec.lowQuality?.factor ?? 1;
    const lq = spec.lowQuality;
    const imageName = lq ? "plan.jpg" : "plan.png";
    const raster = sharp(Buffer.from(svg), { density: 72 });
    const image = lq
      ? await raster
          .resize(Math.round(L.width * k), Math.round(L.height * k))
          .blur(lq.blur)
          .flatten({ background: "#ffffff" })
          .jpeg({ quality: lq.quality })
          .toBuffer()
      : await raster.png().toBuffer();
    const meta = await sharp(image).metadata();

    // 보정: 상단·좌측 전체 치수선을 기준 구간으로, 실내 마감면 사각형을 외곽으로
    const px = (p: Pt): Pt => [r1((L.ox + p[0] * L.s) * k), r1((L.oy + p[1] * L.s) * k)];
    const top = dims.find((d) => d.side === "top" && d.role === "total")!;
    const left = dims.find((d) => d.side === "left" && d.role === "total")!;
    const calibrated = applyCalibration(
      null,
      {
        image: { name: imageName, mimeType: lq ? "image/jpeg" : "image/png", width: meta.width!, height: meta.height! },
        references: [
          { label: `상단 전체 ${top.text}`, a: px(top.a), b: px(top.b), length: top.value },
          { label: `좌측 전체 ${left.text}`, a: px(left.a), b: px(left.b), length: left.value },
        ],
        envelope: { x: px([0, 0])[0], y: px([0, 0])[1], width: r1(truth.envelope.width * L.s * k), height: r1(truth.envelope.depth * L.s * k) },
      },
      spec.id,
    );
    if ("error" in calibrated) throw new Error(`${spec.id}: ${calibrated.error}`);
    const base: FloorPlanDocument = { $schema: SCHEMA_REF, ...calibrated, title: `${spec.id} (AI 추출 전)` };

    const evalCase: EvalCase = {
      id: spec.id,
      description: spec.description,
      categories: spec.categories,
      synthetic: true,
      image: imageName,
      base: "base.json",
      truth: "truth.json",
      fakeExtraction: "fake-extraction.json",
      ceilingHeightMissing: spec.ceilingText === null,
      dimensions: dims.map((d) => {
        const written = Number(d.text) / 1000;
        return { text: d.text, value: written, a: d.a, b: d.b, ...(Math.abs(written - d.value) > 1e-9 ? { conflict: true } : {}) };
      }),
    };
    files.push(
      [path.join(dir, imageName), image],
      [path.join(dir, "base.json"), toJsonText(base)],
      [path.join(dir, "truth.json"), toJsonText(truth)],
      [path.join(dir, "fake-extraction.json"), toJsonText(fakeExtraction(truth, spec, dims, L, k))],
      [path.join(dir, "case.json"), toJsonText(evalCase)],
    );
  }
  return files;
}
