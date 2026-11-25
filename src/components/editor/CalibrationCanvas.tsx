"use client";

import { useRef, useState } from "react";
import { normalizeRect, type PixelRect } from "@/lib/floorPlan/calibration";
import type { Pt } from "@/lib/floorPlan/editor";
import { fitViewBox, useZoomPan } from "./common";

/**
 * 이미지 배율 보정 화면(원본 픽셀 좌표).
 * 도구별로 끌어서 지정한다: 평면도 영역(선택 사항) · 기준 구간 1·2 · 외곽(실내 마감면) 사각형.
 * 휠로 확대·축소, 오른쪽·가운데 버튼으로 끌면 화면을 옮긴다. 기준 구간은 Shift를 누르면 수평·수직으로 고정한다.
 */

export type CalibrationTool = "crop" | "ref1" | "ref2" | "envelope";

export interface CalibrationDraft {
  crop?: PixelRect;
  refs: [{ a: Pt; b: Pt } | null, { a: Pt; b: Pt } | null];
  /** 기준 구간 실제 길이 입력값(m, 문자열) */
  lengths: [string, string];
  envelope?: PixelRect;
}

export const EMPTY_DRAFT: CalibrationDraft = { refs: [null, null], lengths: ["", ""] };

const COLORS = { crop: "#2563eb", ref1: "#dc2626", ref2: "#9333ea", envelope: "#059669" } as const;

export default function CalibrationCanvas({
  image,
  draft,
  tool,
  onChange,
}: {
  image: { url: string; width: number; height: number };
  draft: CalibrationDraft;
  tool: CalibrationTool;
  onChange: (d: CalibrationDraft) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const { vb, setVb, toSvg, unitsPerPixel } = useZoomPan(svgRef, fitViewBox(0, 0, image.width, image.height, 0.03), image.url);
  const [drag, setDrag] = useState<{ a: Pt; b: Pt } | null>(null);
  const [pan, setPan] = useState<{ x: number; y: number; vb: typeof vb } | null>(null);
  const px = unitsPerPixel();
  const clampPt = (p: Pt): Pt => [Math.min(image.width, Math.max(0, p[0])), Math.min(image.height, Math.max(0, p[1]))];

  /** 끌기 끝점(기준 구간은 Shift로 수평·수직 고정) */
  const endPoint = (a: Pt, e: { clientX: number; clientY: number; shiftKey: boolean }): Pt => {
    const b = clampPt(toSvg(e.clientX, e.clientY));
    if (e.shiftKey && (tool === "ref1" || tool === "ref2")) return Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]) ? [b[0], a[1]] : [a[0], b[1]];
    return b;
  };

  const commit = (a: Pt, b: Pt) => {
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 3) return;
    if (tool === "crop") onChange({ ...draft, crop: normalizeRect(a, b) });
    else if (tool === "envelope") onChange({ ...draft, envelope: normalizeRect(a, b) });
    else {
      const refs = [...draft.refs] as CalibrationDraft["refs"];
      refs[tool === "ref1" ? 0 : 1] = { a, b };
      onChange({ ...draft, refs });
    }
  };

  const rect = (r: PixelRect | undefined, color: string, label: string, dashed = false) =>
    r && (
      <g>
        <rect x={r.x} y={r.y} width={r.width} height={r.height} fill={color} fillOpacity={0.06} stroke={color} strokeWidth={2 * px} strokeDasharray={dashed ? `${8 * px} ${5 * px}` : undefined} />
        <text x={r.x + 4 * px} y={r.y - 5 * px} fontSize={13 * px} fill={color} fontWeight={700}>
          {label}
        </text>
      </g>
    );
  const line = (l: { a: Pt; b: Pt } | null, color: string, label: string) =>
    l && (
      <g>
        <line x1={l.a[0]} y1={l.a[1]} x2={l.b[0]} y2={l.b[1]} stroke={color} strokeWidth={2.5 * px} />
        {[l.a, l.b].map((p, i) => (
          <circle key={i} cx={p[0]} cy={p[1]} r={5 * px} fill="#fff" stroke={color} strokeWidth={2 * px} />
        ))}
        <text x={(l.a[0] + l.b[0]) / 2 + 6 * px} y={(l.a[1] + l.b[1]) / 2 - 6 * px} fontSize={13 * px} fill={color} fontWeight={700} style={{ paintOrder: "stroke" }} stroke="#fff" strokeWidth={3 * px}>
          {label} · {Math.round(Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1]))} px
        </text>
      </g>
    );

  const preview = drag && (tool === "crop" || tool === "envelope" ? rect(normalizeRect(drag.a, drag.b), COLORS[tool], "") : line(drag, COLORS[tool], ""));

  return (
    <svg
      ref={svgRef}
      viewBox={vb.join(" ")}
      className="h-full w-full cursor-crosshair touch-none select-none bg-slate-200"
      role="img"
      aria-label="이미지 배율 보정: 끌어서 영역·기준 구간·외곽을 지정"
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        if (e.button === 2 || e.button === 1) {
          setPan({ x: e.clientX, y: e.clientY, vb });
          return;
        }
        const p = clampPt(toSvg(e.clientX, e.clientY));
        setDrag({ a: p, b: p });
      }}
      onPointerMove={(e) => {
        if (pan) {
          const s = unitsPerPixel();
          setVb([pan.vb[0] - (e.clientX - pan.x) * s, pan.vb[1] - (e.clientY - pan.y) * s, pan.vb[2], pan.vb[3]]);
          return;
        }
        if (drag) setDrag({ ...drag, b: endPoint(drag.a, e) });
      }}
      onPointerUp={(e) => {
        // 마지막 pointermove의 상태가 아직 반영되지 않았을 수 있으므로 놓은 위치로 다시 계산한다.
        if (drag) commit(drag.a, endPoint(drag.a, e));
        setDrag(null);
        setPan(null);
      }}
    >
      <image href={image.url} x={0} y={0} width={image.width} height={image.height} preserveAspectRatio="none" />
      {rect(draft.crop, COLORS.crop, "평면도 영역", true)}
      {rect(draft.envelope, COLORS.envelope, "외곽(실내 마감면)")}
      {line(draft.refs[0], COLORS.ref1, `기준 1${draft.lengths[0] ? ` = ${draft.lengths[0]} m` : ""}`)}
      {line(draft.refs[1], COLORS.ref2, `기준 2${draft.lengths[1] ? ` = ${draft.lengths[1]} m` : ""}`)}
      {preview}
    </svg>
  );
}

export const CALIBRATION_COLORS = COLORS;
