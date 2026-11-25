"use client";

import { useEffect, useRef } from "react";
import { subscribeViewZoom } from "@/lib/three/cameraPose";
import { useViewerStore } from "@/store/viewerStore";

/**
 * 1인칭 화면 하단 안내(시점 버튼 위).
 * - 마우스 환경: 잠금 전에는 "클릭하면 마우스로 시점 조작", 잠금 중에는 "Esc 해제"를 흐리게 보여준다.
 * - 휠·두 손가락으로 확대·축소 중이면 배율을 함께 보여준다(프레임마다 React 렌더 없이 DOM만 갱신).
 * 화면 중심은 비워 둔다(십자선 없음).
 */
export default function LookHint() {
  const locked = useViewerStore((s) => s.pointerLocked);
  const zoomRef = useRef<HTMLSpanElement>(null);

  useEffect(
    () =>
      subscribeViewZoom((zoom) => {
        const el = zoomRef.current;
        if (!el) return;
        el.textContent = `확대 ×${zoom.toFixed(1)}`;
        el.hidden = Math.abs(zoom - 1) <= 0.02;
      }),
    [],
  );

  return (
    <div className="pointer-events-none absolute bottom-16 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap text-xs">
      <span
        className={`hidden rounded-full px-3 py-1 backdrop-blur transition-opacity pointer-fine:inline ${
          locked ? "bg-stone-900/45 text-stone-200 opacity-70" : "bg-stone-900/70 text-white"
        }`}
      >
        {locked ? "마우스로 시점 이동 중 · Esc 해제" : "화면을 클릭하면 마우스로 시점을 움직입니다"}
      </span>
      <span ref={zoomRef} hidden className="rounded-full bg-stone-900/70 px-2.5 py-1 tabular-nums text-white backdrop-blur" />
    </div>
  );
}
