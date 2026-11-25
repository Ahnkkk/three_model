"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Pt } from "@/lib/floorPlan/editor";

/** SVG viewBox [x, y, w, h] */
export type ViewBox = [number, number, number, number];

/** 사각형이 화면에 들어오도록 여백을 둔 viewBox */
export function fitViewBox(x: number, y: number, w: number, h: number, margin = 0.08): ViewBox {
  const mx = Math.max(w, h) * margin;
  return [x - mx, y - mx, w + mx * 2, h + mx * 2];
}

/**
 * 휠 확대·축소(포인터 위치 기준)와 화면 좌표 → SVG 좌표 변환.
 * fitKey가 바뀌면 fit으로 다시 맞춘다(새 도면·새 이미지).
 */
export function useZoomPan(svgRef: RefObject<SVGSVGElement | null>, fit: ViewBox, fitKey: string) {
  const [vb, setVb] = useState<ViewBox>(fit);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  useEffect(() => setVb(fitRef.current), [fitKey]);

  const toSvg = useCallback(
    (clientX: number, clientY: number): Pt => {
      const svg = svgRef.current;
      const ctm = svg?.getScreenCTM();
      if (!svg || !ctm) return [0, 0];
      const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
      return [p.x, p.y];
    },
    [svgRef],
  );

  /** 화면 1px의 SVG 길이 */
  const unitsPerPixel = useCallback(() => {
    const svg = svgRef.current;
    if (!svg) return vb[2] / 800;
    const r = svg.getBoundingClientRect();
    return Math.max(vb[2] / Math.max(1, r.width), vb[3] / Math.max(1, r.height));
  }, [svgRef, vb]);

  // React의 onWheel은 passive라 기본 스크롤을 막을 수 없으므로 직접 등록한다.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
      const k = Math.exp(e.deltaY * 0.0015);
      setVb(([x, y, w, h]) => {
        const nw = Math.min(fitRef.current[2] * 8, Math.max(fitRef.current[2] / 40, w * k));
        const s = nw / w;
        return [p.x - (p.x - x) * s, p.y - (p.y - y) * s, nw, h * s];
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [svgRef]);

  return { vb, setVb, toSvg, unitsPerPixel, reset: () => setVb(fitRef.current) };
}

/** 숫자 입력: 입력 중에는 글자를 그대로 두고 Enter·포커스 이동 때 반영한다. 숫자가 아니거나 범위 밖이면 되돌린다. */
export function NumberField({
  label,
  value,
  onCommit,
  min,
  max,
  step = 0.01,
  unit = "m",
  disabled,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number(text);
    if (!Number.isFinite(n) || (min !== undefined && n < min) || (max !== undefined && n > max)) {
      setText(String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };
  return (
    <label className="flex items-center justify-between gap-2 text-xs">
      <span className="text-slate-500">{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          inputMode="decimal"
          step={step}
          min={min}
          max={max}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setText(String(value));
          }}
          className="w-20 rounded border border-slate-300 px-1.5 py-0.5 text-right tabular-nums disabled:bg-slate-100 disabled:text-slate-400"
        />
        <span className="w-4 text-slate-400">{unit}</span>
      </span>
    </label>
  );
}

export function SelectField<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <label className="flex items-center justify-between gap-2 text-xs">
      <span className="text-slate-500">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)} className="rounded border border-slate-300 bg-white px-1.5 py-0.5">
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

export const BUTTON = "rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40";
export const BUTTON_PRIMARY = "rounded-md bg-[#14305c] px-2.5 py-1 text-xs font-semibold text-white hover:bg-[#1d3f75] disabled:cursor-not-allowed disabled:opacity-40";
