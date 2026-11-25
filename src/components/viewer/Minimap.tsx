"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { subscribeCameraPose } from "@/lib/three/cameraPose";
import { useViewerStore } from "@/store/viewerStore";
import { ExteriorWallsPlan, FurnitureSymbol, PartitionPlan, floorColor } from "@/components/office/FloorPlanSvg";
import { useResolvedScene } from "./SceneConfigContext";

/**
 * 미니맵(내비게이션): 장면 데이터로 그린 평면도 위에 현재 카메라 위치·시선·시야각을 표시한다.
 * 평면은 북쪽(-z)이 위로 고정되고, 카메라 표식만 회전한다. SVG 좌표 = 월드 (x, z), 단위 m.
 * 카메라 표식은 프레임 루프의 알림(cameraPose)을 받아 DOM 속성만 바꾼다(React 다시 그리기 없음).
 * 지도를 클릭하면 그 위치로 이동을 요청한다(viewerStore.requestMoveTo → CameraControls).
 */

const MARKER = "#f5b23c";

/** 시야 부채꼴(로컬 +x 방향, 반지름 r, 전체 각 fov) */
function conePath(r: number, fov: number): string {
  const h = Math.min(fov, Math.PI * 0.95) / 2;
  const x = r * Math.cos(h);
  const y = r * Math.sin(h);
  return `M 0 0 L ${x} ${-y} A ${r} ${r} 0 0 1 ${x} ${y} Z`;
}

export default function Minimap() {
  const scene = useResolvedScene();
  const { room } = scene;
  const W = room.width;
  const D = room.depth;
  const t = room.wallThickness;
  const margin = 0.25;
  const vb = [-W / 2 - t - margin, -D / 2 - t - margin, W + 2 * (t + margin), D + 2 * (t + margin)];
  const aspect = vb[2] / vb[3];
  // 표식 크기는 평면 크기에 비례(사무실 18m·거실 6m에서 화면상 비슷한 크기)
  const span = Math.max(vb[2], vb[3]);
  const dot = span * 0.016;
  const coneR = span * 0.13;

  // 좁은 화면에서는 접어서 시작한다(위쪽 다른 버튼과 겹치지 않게).
  const [open, setOpen] = useState(() => typeof window === "undefined" || window.matchMedia("(min-width: 1024px)").matches);
  const markerRef = useRef<SVGGElement>(null);
  const coneRef = useRef<SVGPathElement>(null);
  const lastFov = useRef(0);
  const requestMoveTo = useViewerStore((s) => s.requestMoveTo);
  const [ping, setPing] = useState<{ x: number; z: number; key: number } | null>(null);

  /** 클릭 위치(화면 좌표) → 월드 x, z로 바꿔 이동을 요청한다. 실제 도착점은 가장 가까운 빈자리(CameraControls). */
  const onMapClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    requestMoveTo(p.x, p.y);
    setPing({ x: p.x, z: p.y, key: Date.now() });
  };
  useEffect(() => {
    if (!ping) return;
    const id = window.setTimeout(() => setPing(null), 800);
    return () => window.clearTimeout(id);
  }, [ping]);

  useEffect(() => {
    if (!open) return;
    lastFov.current = 0;
    return subscribeCameraPose((pose) => {
      const marker = markerRef.current;
      if (!marker) return;
      if (!pose) {
        marker.setAttribute("visibility", "hidden");
        return;
      }
      marker.setAttribute("visibility", "visible");
      marker.setAttribute("transform", `translate(${pose.x} ${pose.z}) rotate(${(pose.heading * 180) / Math.PI})`);
      if (Math.abs(pose.hfov - lastFov.current) > 1e-3) {
        lastFov.current = pose.hfov;
        coneRef.current?.setAttribute("d", conePath(coneR, pose.hfov));
      }
    });
  }, [open, coneR]);

  const plan = useMemo(
    () => (
      <>
        <rect x={-W / 2} y={-D / 2} width={W} height={D} fill={floorColor(scene.surfaceMaterials.floor)} />
        {scene.floorZones.map((z) => (
          <rect key={z.id} x={z.rect[0]} y={z.rect[1]} width={z.rect[2] - z.rect[0]} height={z.rect[3] - z.rect[1]} fill={floorColor(z.material)} />
        ))}
        {scene.furniture.map((it) => (
          <g key={it.id} transform={`translate(${it.position[0]} ${it.position[2]}) rotate(${-(it.rotationY ?? 0)})`}>
            <FurnitureSymbol item={it} />
          </g>
        ))}
        {scene.partitions.map((p) => (
          <PartitionPlan key={p.id} p={p} />
        ))}
        <ExteriorWallsPlan room={room} />
        {scene.columns?.map((c) => (
          <rect key={c.id} x={c.center[0] - c.size[0] / 2} y={c.center[1] - c.size[1] / 2} width={c.size[0]} height={c.size[1]} fill="#55565a" />
        ))}
        {scene.mapLabels?.map((l) => (
          <text
            key={l.id}
            x={l.at[0]}
            y={l.at[1]}
            fontSize={span * 0.028}
            fontWeight={700}
            fill="#ffffff"
            stroke="#00000088"
            strokeWidth={span * 0.004}
            textAnchor="middle"
            dominantBaseline="middle"
            style={{ paintOrder: "stroke" }}
          >
            {l.text}
          </text>
        ))}
      </>
    ),
    [scene, room, W, D, span],
  );

  return (
    <div
      className="pointer-events-auto overflow-hidden rounded-xl border border-white/10 bg-stone-900/85 text-xs shadow-lg backdrop-blur"
      // 높이 약 12rem 기준으로 평면 비율에 맞춘 폭(가로로 긴 사무실은 최대 26rem)
      style={{ width: open ? `min(26rem, ${(12 * aspect).toFixed(2)}rem, calc(100vw - 2rem))` : undefined }}
    >
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center justify-between gap-3 px-3 py-1.5 hover:bg-white/5">
        <span className="font-semibold">미니맵</span>
        <span className="flex items-center gap-2 text-stone-400">
          {open && <span title="위쪽이 북쪽">N ↑</span>}
          <span>{open ? "▲" : "▼"}</span>
        </span>
      </button>
      {open && (
        <div className="px-2 pb-1.5">
          <svg
            viewBox={vb.join(" ")}
            className="block h-auto w-full cursor-crosshair rounded-md bg-stone-800/60"
            role="img"
            aria-label={`${scene.title} 미니맵: 현재 위치와 바라보는 방향. 클릭하면 그 위치로 이동`}
            onClick={onMapClick}
          >
            {plan}
            {/* 클릭한 목적지 표시(잠깐 퍼졌다 사라짐) */}
            {ping && (
              <circle key={ping.key} cx={ping.x} cy={ping.z} r={dot} fill="none" stroke="#ffffff" strokeWidth={span * 0.005}>
                <animate attributeName="r" from={dot} to={dot * 4} dur="0.7s" fill="freeze" />
                <animate attributeName="opacity" from="1" to="0" dur="0.7s" fill="freeze" />
              </circle>
            )}
            {/* 현재 위치·시선(카메라 알림으로 갱신) */}
            <g ref={markerRef} visibility="hidden" pointerEvents="none">
              <path ref={coneRef} d={conePath(coneR, Math.PI / 2)} fill={MARKER} fillOpacity={0.28} stroke={MARKER} strokeOpacity={0.8} strokeWidth={span * 0.004} />
              <circle r={dot} fill={MARKER} stroke="#ffffff" strokeWidth={dot * 0.45} />
            </g>
          </svg>
          <p className="mt-1 text-center text-[10px] text-stone-400">지도를 클릭하면 그 위치로 이동합니다</p>
        </div>
      )}
    </div>
  );
}
