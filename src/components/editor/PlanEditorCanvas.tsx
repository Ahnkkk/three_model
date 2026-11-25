"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  addOpening,
  addWall,
  moveOpening,
  nearestWall,
  nextId,
  pointOnWall,
  projectOnWall,
  snapPoint,
  translateWall,
  updateWall,
  wallGeoms,
  wallLength,
  type Pt,
  type SnapKind,
  type WallGeom,
} from "@/lib/floorPlan/editor";
import type { FloorPlanDocument, FloorPlanOpening } from "@/lib/floorPlan/schema";
import { furnitureFootprint } from "@/lib/floorPlan/ai/proposal";
import type { AiOverlay } from "./AiExtractPanel";
import { fitViewBox, useZoomPan } from "./common";

/**
 * 구조 편집 화면(도면 좌표 u, v — m). 보정한 원본 이미지를 아래에 겹쳐 표시한다(pixelToPlan 변환).
 * - 선택: 벽·개구부·가구를 눌러 선택, 벽은 끌어서 이동, 끝점 손잡이로 길이·방향 변경, 개구부는 벽을 따라 이동
 * - 벽(불투명·유리): 클릭으로 시작점 → 클릭으로 끝점(이어서 그리기). 더블클릭·Esc로 끝냄
 * - 문·창·통로: 벽 가까이 클릭해 추가
 * 끌기 중에는 미리보기만 바꾸고 놓을 때 한 번 반영한다(실행 취소 한 단계, 3D는 놓은 뒤 갱신).
 * 휠 확대·축소, 오른쪽·가운데 버튼(선택 도구에서는 빈 곳 왼쪽 버튼도)으로 끌면 화면 이동.
 */

export type EditorTool = "select" | "wall-solid" | "wall-glass" | "door" | "window" | "passage";
export type Selection = { kind: "wall" | "opening" | "furniture"; id: string } | null;

type Drag =
  | { type: "wall"; id: string; origin: Pt; base: FloorPlanDocument; preview: FloorPlanDocument | null }
  | { type: "end"; id: string; which: "start" | "end"; base: FloorPlanDocument; preview: FloorPlanDocument | null }
  | { type: "opening"; id: string; base: FloorPlanDocument; preview: FloorPlanDocument | null }
  | { type: "pan"; x: number; y: number; vb: [number, number, number, number] };

const OPENING_COLORS: Record<FloorPlanOpening["kind"], string> = { door: "#ea580c", window: "#0284c7", passage: "#64748b" };
const SNAP_COLORS: Record<SnapKind, string> = { endpoint: "#16a34a", edge: "#0891b2", ortho: "#7c3aed", grid: "#64748b", free: "#64748b" };
const SELECT = "#f59e0b";
const ERROR = "#dc2626";
const GRID_STEP = 0.05;

export default function PlanEditorCanvas({
  doc,
  fitKey,
  underlay,
  tool,
  selection,
  onSelect,
  onApply,
  flagged,
  onMessage,
  aiOverlay,
}: {
  doc: FloorPlanDocument;
  fitKey: string;
  underlay?: { url: string; width: number; height: number; matrix: number[]; opacity: number };
  tool: EditorTool;
  selection: Selection;
  onSelect: (s: Selection) => void;
  onApply: (update: (d: FloorPlanDocument) => FloorPlanDocument, select?: Selection) => void;
  /** "wall:id"·"opening:id"·"furniture:id" → 오류(error) 또는 미확인(unconfirmed) */
  flagged: Map<string, "error" | "unconfirmed">;
  onMessage: (m: string) => void;
  /** AI 추출 제안(적용 전 미리보기) */
  aiOverlay?: AiOverlay | null;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const { width: W, depth: D, wallThickness: T } = doc.envelope;
  const { vb, setVb, toSvg, unitsPerPixel } = useZoomPan(svgRef, fitViewBox(-T, -T, W + 2 * T, D + 2 * T, 0.1), fitKey);
  const [drawStart, setDrawStart] = useState<Pt | null>(null);
  const [hover, setHover] = useState<{ point: Pt; kind: SnapKind } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const moved = useRef(false);
  const px = unitsPerPixel();
  const radius = 12 * px;

  const shown = drag && drag.type !== "pan" && drag.preview ? drag.preview : doc;
  const geoms = useMemo(() => new Map(wallGeoms(shown).map((w) => [w.id, w])), [shown]);
  const wallTool = tool === "wall-solid" || tool === "wall-glass";
  const openingTool = tool === "door" || tool === "window" || tool === "passage";

  // 도구가 바뀌면 그리던 벽을 취소하고, Esc로 그리기·끌기를 끝낸다.
  useEffect(() => {
    setDrawStart(null);
    setHover(null);
  }, [tool]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setDrawStart(null);
      setDrag(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const snapOpts = (from?: Pt, excludeWallId?: string) => ({ radius, grid: GRID_STEP, from, excludeWallId });

  /* ------------------------------ 포인터 ------------------------------ */

  const onBackgroundDown = (e: React.PointerEvent<SVGSVGElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    moved.current = false;
    if (e.button === 1 || e.button === 2 || (tool === "select" && e.button === 0)) {
      if (tool === "select" && e.button === 0) onSelect(null);
      setDrag({ type: "pan", x: e.clientX, y: e.clientY, vb });
      return;
    }
    if (e.button !== 0) return;
    const raw = toSvg(e.clientX, e.clientY);
    if (wallTool) {
      const sp = snapPoint(doc, raw, snapOpts(drawStart ?? undefined));
      if (!drawStart) {
        setDrawStart(sp.point);
        return;
      }
      if (Math.hypot(sp.point[0] - drawStart[0], sp.point[1] - drawStart[1]) < 0.05) return;
      const id = nextId(doc, "wall");
      const kind = tool === "wall-glass" ? "glass" : "solid";
      const start = drawStart;
      onApply((d) => addWall(d, start, sp.point, kind).doc, { kind: "wall", id });
      setDrawStart(sp.point); // 이어서 그리기
      return;
    }
    if (openingTool) {
      const near = nearestWall(doc, raw, Math.max(0.35, radius * 1.5));
      if (!near) {
        onMessage("벽 가까이를 클릭하세요.");
        return;
      }
      const res = addOpening(doc, near.wall.id, tool, near.t);
      if (!res) {
        onMessage("내부 벽에는 창을 둘 수 없습니다(단기 지원 범위: 내부 벽은 문·통로만).");
        return;
      }
      onApply(() => res.doc, { kind: "opening", id: res.id });
    }
  };

  const startElementDrag = (e: React.PointerEvent, d: Drag, sel: Selection) => {
    if (tool !== "select" || e.button !== 0) return; // 다른 도구는 배경 처리(벽 위 클릭으로 개구부 추가 등)
    e.stopPropagation();
    svgRef.current?.setPointerCapture(e.pointerId);
    moved.current = false;
    onSelect(sel);
    setDrag(d);
  };

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const raw = toSvg(e.clientX, e.clientY);
    if (!drag) {
      if (wallTool) setHover(snapPoint(doc, raw, snapOpts(drawStart ?? undefined)));
      else if (openingTool) {
        const near = nearestWall(doc, raw, Math.max(0.35, radius * 1.5));
        setHover(near ? { point: pointOnWall(near.wall, near.t).p, kind: "edge" } : null);
      } else setHover(null);
      return;
    }
    if (drag.type === "pan") {
      const s = unitsPerPixel();
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 3) moved.current = true;
      setVb([drag.vb[0] - (e.clientX - drag.x) * s, drag.vb[1] - (e.clientY - drag.y) * s, drag.vb[2], drag.vb[3]]);
      return;
    }
    moved.current = true;
    setDrag({ ...drag, preview: dragPreview(drag, raw) });
  };

  /** 끌기 중인 항목을 포인터 위치(raw)로 옮긴 미리보기 문서 */
  const dragPreview = (d: Exclude<Drag, { type: "pan" }>, raw: Pt): FloorPlanDocument => {
    if (d.type === "wall") {
      const g = (n: number) => Math.round(n / GRID_STEP) * GRID_STEP;
      return translateWall(d.base, d.id, g(raw[0] - d.origin[0]), g(raw[1] - d.origin[1]));
    }
    if (d.type === "end") {
      const w = d.base.walls.find((x) => x.id === d.id)!;
      const other = d.which === "start" ? w.end : w.start;
      const sp = snapPoint(d.base, raw, snapOpts([other[0], other[1]], d.id));
      setHover(sp);
      return updateWall(d.base, d.id, { [d.which]: sp.point });
    }
    const o = d.base.openings.find((x) => x.id === d.id)!;
    const cur = wallGeoms(d.base).find((w) => w.id === o.wallId)!;
    const onCur = projectOnWall(cur, raw);
    const near = nearestWall(d.base, raw, radius);
    // 다른 벽에 충분히 가까우면 그 벽으로 옮긴다.
    const target = near && near.wall.id !== cur.id && near.dist < onCur.dist - radius / 2 ? near : { wall: cur, t: onCur.t };
    return moveOpening(d.base, d.id, target.wall.id, target.t);
  };

  const onUp = (e: React.PointerEvent<SVGSVGElement>) => {
    // 마지막 pointermove의 상태가 아직 반영되지 않았을 수 있으므로 놓은 위치로 다시 계산한다.
    if (drag && drag.type !== "pan" && moved.current) {
      const preview = dragPreview(drag, toSvg(e.clientX, e.clientY));
      if (preview !== drag.base) onApply(() => preview);
    }
    setDrag(null);
    if (!wallTool) setHover(null);
  };

  /* ------------------------------ 그리기 ------------------------------ */

  const flagColor = (key: string) => (flagged.get(key) === "error" ? ERROR : flagged.get(key) === "unconfirmed" ? "#d97706" : null);
  const isSel = (kind: NonNullable<Selection>["kind"], id: string) => selection?.kind === kind && selection.id === id;

  /** 개구부를 그릴 벽 위 구간(외곽 벽은 벽 두께 가운데 선) */
  const openingSegment = (o: FloorPlanOpening, w: WallGeom) => {
    const len = wallLength(w) || 1;
    const dir: Pt = [(w.end[0] - w.start[0]) / len, (w.end[1] - w.start[1]) / len];
    const n: Pt = [-dir[1], dir[0]]; // 왼쪽 법선(외곽 벽에서는 실내 쪽, 문 swing "pos")
    const shift = w.exterior ? -T / 2 : 0;
    const at = (t: number, s = 0): Pt => [w.start[0] + dir[0] * t + n[0] * (shift + s), w.start[1] + dir[1] * t + n[1] * (shift + s)];
    return { a: at(o.offset - o.width / 2), b: at(o.offset + o.width / 2), dir, n, at };
  };

  const walls = shown.walls;
  const thicknessOf = (w: WallGeom) => (w.exterior ? T : walls.find((x) => x.id === w.id)?.thickness ?? 0.1);

  return (
    <svg
      ref={svgRef}
      viewBox={vb.join(" ")}
      className={`h-full w-full touch-none select-none bg-slate-50 ${tool === "select" ? (drag?.type === "pan" ? "cursor-grabbing" : "cursor-default") : "cursor-crosshair"}`}
      role="img"
      aria-label="도면 구조 편집"
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={onBackgroundDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={() => !drag && setHover(null)}
      onDoubleClick={() => setDrawStart(null)}
    >
      <defs>
        <pattern id="editor-grid" width={0.5} height={0.5} patternUnits="userSpaceOnUse">
          <path d="M 0.5 0 L 0 0 0 0.5" fill="none" stroke="#cbd5e1" strokeWidth={px} />
        </pattern>
      </defs>

      {/* 원본 이미지(보정 변환) */}
      {underlay && (
        <image
          href={underlay.url}
          width={underlay.width}
          height={underlay.height}
          transform={`matrix(${underlay.matrix.join(" ")})`}
          opacity={underlay.opacity}
          preserveAspectRatio="none"
          pointerEvents="none"
        />
      )}

      {/* 바닥·격자·영역 */}
      <rect x={0} y={0} width={W} height={D} fill={underlay ? "none" : "#ffffff"} stroke="none" />
      <rect x={0} y={0} width={W} height={D} fill="url(#editor-grid)" opacity={underlay ? 0.5 : 1} pointerEvents="none" />
      {shown.zones?.map((z) => (
        <g key={z.id} pointerEvents="none">
          <rect x={z.rect[0]} y={z.rect[1]} width={z.rect[2] - z.rect[0]} height={z.rect[3] - z.rect[1]} fill="#e0f2fe" fillOpacity={0.35} stroke="#7dd3fc" strokeWidth={px} />
          <text x={(z.rect[0] + z.rect[2]) / 2} y={(z.rect[1] + z.rect[3]) / 2} fontSize={11 * px} fill="#0369a1" textAnchor="middle">
            {z.name}
          </text>
        </g>
      ))}

      {/* 외곽 벽(실내 면 바깥) */}
      <g fill="#94a3b8" fillOpacity={underlay ? 0.55 : 1} pointerEvents="none">
        <rect x={-T} y={-T} width={W + 2 * T} height={T} />
        <rect x={-T} y={D} width={W + 2 * T} height={T} />
        <rect x={-T} y={0} width={T} height={D} />
        <rect x={W} y={0} width={T} height={D} />
      </g>

      {/* 기둥·가구 */}
      {shown.columns?.map((c) => (
        <rect key={c.id} x={c.center[0] - c.size[0] / 2} y={c.center[1] - c.size[1] / 2} width={c.size[0]} height={c.size[1]} fill="#64748b" pointerEvents="none" />
      ))}
      {shown.furniture?.map((f) => {
        const color = isSel("furniture", f.id) ? SELECT : flagColor(`furniture:${f.id}`);
        return (
          <g
            key={f.id}
            data-furniture={f.id}
            transform={`translate(${f.position[0]} ${f.position[2]}) rotate(${-(f.rotation ?? 0)})`}
            onPointerDown={(e) => {
              if (tool !== "select" || e.button !== 0) return;
              e.stopPropagation();
              onSelect({ kind: "furniture", id: f.id });
            }}
          >
            <title>{f.label ?? f.kind}</title>
            <rect
              x={-f.size[0] / 2}
              y={-f.size[2] / 2}
              width={f.size[0]}
              height={f.size[2]}
              fill={f.kind === "unknown" ? "#fef3c7" : "#e2e8f0"}
              fillOpacity={0.85}
              stroke={color ?? "#94a3b8"}
              strokeWidth={(color ? 2.5 : 1) * px}
              strokeDasharray={f.kind === "unknown" ? `${4 * px} ${3 * px}` : undefined}
            />
          </g>
        );
      })}

      {/* 내부 벽 */}
      {walls.map((w) => {
        const sel = isSel("wall", w.id);
        const flag = flagColor(`wall:${w.id}`);
        return (
          <g key={w.id}>
            <line x1={w.start[0]} y1={w.start[1]} x2={w.end[0]} y2={w.end[1]} stroke={w.kind === "glass" ? "#14b8a6" : "#334155"} strokeWidth={w.thickness} strokeOpacity={underlay ? 0.85 : 1} />
            {(sel || flag) && (
              <line
                x1={w.start[0]}
                y1={w.start[1]}
                x2={w.end[0]}
                y2={w.end[1]}
                stroke={sel ? SELECT : flag!}
                strokeWidth={w.thickness + 4 * px}
                strokeOpacity={0.55}
                strokeDasharray={!sel ? `${6 * px} ${4 * px}` : undefined}
                pointerEvents="none"
              />
            )}
            {/* 선택용 넓은 영역 */}
            <line
              x1={w.start[0]}
              y1={w.start[1]}
              x2={w.end[0]}
              y2={w.end[1]}
              stroke="transparent"
              strokeWidth={Math.max(w.thickness, 12 * px)}
              data-wall={w.id}
              className={tool === "select" ? "cursor-move" : undefined}
              onPointerDown={(e) => startElementDrag(e, { type: "wall", id: w.id, origin: toSvg(e.clientX, e.clientY), base: doc, preview: null }, { kind: "wall", id: w.id })}
            />
          </g>
        );
      })}

      {/* 개구부 */}
      {shown.openings.map((o) => {
        const w = geoms.get(o.wallId);
        if (!w) return null;
        const seg = openingSegment(o, w);
        const t = thicknessOf(w);
        const sel = isSel("opening", o.id);
        const flag = flagColor(`opening:${o.id}`);
        const leaf = (() => {
          if (o.kind !== "door" || !o.door || o.door.leaf === "none") return null;
          const start = o.door.hinge === "start";
          const hingeT = start ? o.offset - o.width / 2 : o.offset + o.width / 2;
          const hinge = seg.at(hingeT);
          const closed = seg.at(start ? hingeT + o.width : hingeT - o.width);
          const a = (o.door.angle * Math.PI) / 180;
          const dirSign = start ? 1 : -1;
          const side = o.door.swing === "pos" ? 1 : -1;
          const tip: Pt = [
            hinge[0] + (seg.dir[0] * dirSign * Math.cos(a) + seg.n[0] * side * Math.sin(a)) * o.width,
            hinge[1] + (seg.dir[1] * dirSign * Math.cos(a) + seg.n[1] * side * Math.sin(a)) * o.width,
          ];
          const cross = (closed[0] - hinge[0]) * (tip[1] - hinge[1]) - (closed[1] - hinge[1]) * (tip[0] - hinge[0]);
          return (
            <g pointerEvents="none">
              <path d={`M ${closed[0]} ${closed[1]} A ${o.width} ${o.width} 0 0 ${cross > 0 ? 1 : 0} ${tip[0]} ${tip[1]}`} fill="none" stroke={OPENING_COLORS.door} strokeWidth={px} strokeDasharray={`${4 * px} ${3 * px}`} />
              <line x1={hinge[0]} y1={hinge[1]} x2={tip[0]} y2={tip[1]} stroke={OPENING_COLORS.door} strokeWidth={2.5 * px} strokeLinecap="round" />
            </g>
          );
        })();
        return (
          <g key={o.id}>
            <line x1={seg.a[0]} y1={seg.a[1]} x2={seg.b[0]} y2={seg.b[1]} stroke="#ffffff" strokeWidth={t + 2 * px} />
            <line
              x1={seg.a[0]}
              y1={seg.a[1]}
              x2={seg.b[0]}
              y2={seg.b[1]}
              stroke={sel ? SELECT : flag ?? OPENING_COLORS[o.kind]}
              strokeWidth={Math.max(t * 0.6, 4 * px)}
              strokeDasharray={o.kind === "passage" ? `${5 * px} ${3 * px}` : undefined}
            />
            {leaf}
            <line
              x1={seg.a[0]}
              y1={seg.a[1]}
              x2={seg.b[0]}
              y2={seg.b[1]}
              stroke="transparent"
              strokeWidth={Math.max(t, 14 * px)}
              data-opening={o.id}
              className={tool === "select" ? "cursor-ew-resize" : undefined}
              onPointerDown={(e) => startElementDrag(e, { type: "opening", id: o.id, base: doc, preview: null }, { kind: "opening", id: o.id })}
            >
              <title>{`${o.id} (${o.kind}) · 폭 ${o.width} m`}</title>
            </line>
          </g>
        );
      })}

      {/* 선택한 벽의 끝점 손잡이 */}
      {selection?.kind === "wall" &&
        tool === "select" &&
        walls
          .filter((w) => w.id === selection.id)
          .flatMap((w) =>
            (["start", "end"] as const).map((which) => (
              <circle
                key={which}
                cx={w[which][0]}
                cy={w[which][1]}
                r={6 * px}
                fill="#ffffff"
                stroke={SELECT}
                strokeWidth={2.5 * px}
                className="cursor-pointer"
                onPointerDown={(e) => startElementDrag(e, { type: "end", id: w.id, which, base: doc, preview: null }, { kind: "wall", id: w.id })}
              />
            )),
          )}

      {aiOverlay && <AiProposalLayer overlay={aiOverlay} px={px} />}

      {/* 그리는 중인 벽·맞춤 표시 */}
      {wallTool && drawStart && hover && (
        <g pointerEvents="none">
          <line x1={drawStart[0]} y1={drawStart[1]} x2={hover.point[0]} y2={hover.point[1]} stroke={tool === "wall-glass" ? "#14b8a6" : "#334155"} strokeWidth={tool === "wall-glass" ? 0.08 : 0.12} strokeOpacity={0.5} />
          <text
            x={(drawStart[0] + hover.point[0]) / 2}
            y={(drawStart[1] + hover.point[1]) / 2 - 8 * px}
            fontSize={12 * px}
            textAnchor="middle"
            fill="#0f172a"
            style={{ paintOrder: "stroke" }}
            stroke="#fff"
            strokeWidth={3 * px}
          >
            {Math.hypot(hover.point[0] - drawStart[0], hover.point[1] - drawStart[1]).toFixed(2)} m
          </text>
        </g>
      )}
      {hover && (
        <circle cx={hover.point[0]} cy={hover.point[1]} r={5 * px} fill="none" stroke={SNAP_COLORS[hover.kind]} strokeWidth={2 * px} pointerEvents="none" />
      )}

      {/* 외곽 치수 */}
      <g fontSize={13 * px} fill="#334155" fontWeight={700} textAnchor="middle" pointerEvents="none">
        <text x={W / 2} y={-T - 8 * px}>
          {W} m
        </text>
        <text x={-T - 8 * px} y={D / 2} transform={`rotate(-90 ${-T - 8 * px} ${D / 2})`}>
          {D} m
        </text>
      </g>
    </svg>
  );
}

/** AI 제안 미리보기: 고른 항목은 진한 실선, 고르지 않은 항목은 옅은 점선(추가·변경만) */
function AiProposalLayer({ overlay, px }: { overlay: AiOverlay; px: number }) {
  const { proposal } = overlay.result;
  const shown = new Map(overlay.changes.filter((c) => c.action !== "same" && !c.blocked).map((c) => [c.key, overlay.selected.has(c.key)]));
  const style = (on: boolean) => ({ stroke: AI_COLOR, strokeOpacity: on ? 0.95 : 0.45, strokeDasharray: on ? undefined : `${6 * px} ${4 * px}` });
  return (
    <g pointerEvents="none" data-ai-overlay="">
      {proposal.furniture.map((f) => {
        const on = shown.get(`furniture:${f.ref}`);
        if (on === undefined) return null;
        const [u0, v0, u1, v1] = furnitureFootprint(f);
        return <rect key={f.ref} x={u0} y={v0} width={u1 - u0} height={v1 - v0} fill={AI_COLOR} fillOpacity={on ? 0.12 : 0.04} strokeWidth={1.5 * px} {...style(on)} />;
      })}
      {proposal.walls.map((w) => {
        const on = shown.get(`wall:${w.ref}`);
        if (on === undefined) return null;
        return <line key={w.ref} x1={w.start[0]} y1={w.start[1]} x2={w.end[0]} y2={w.end[1]} strokeWidth={Math.max(w.thickness, 3 * px)} strokeLinecap="butt" {...style(on)} />;
      })}
      {proposal.openings.map((o) => {
        const on = shown.get(`opening:${o.ref}`);
        if (on === undefined) return null;
        return (
          <g key={o.ref}>
            <line x1={o.a[0]} y1={o.a[1]} x2={o.b[0]} y2={o.b[1]} strokeWidth={6 * px} strokeLinecap="round" {...style(on)} stroke={OPENING_COLORS[o.kind]} />
            <circle cx={(o.a[0] + o.b[0]) / 2} cy={(o.a[1] + o.b[1]) / 2} r={3 * px} fill={AI_COLOR} fillOpacity={on ? 1 : 0.4} />
          </g>
        );
      })}
    </g>
  );
}

const AI_COLOR = "#7c3aed";
