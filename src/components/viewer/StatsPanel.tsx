"use client";

import { useViewerStore } from "@/store/viewerStore";
import { useSceneConfig } from "./SceneConfigContext";

/** 기본 성능 측정 표시(0.5초 간격 갱신) */
export default function StatsPanel() {
  const stats = useViewerStore((s) => s.stats);
  const backend = useViewerStore((s) => s.backend);
  const caps = useViewerStore((s) => s.capabilities);
  const prepareMs = useViewerStore((s) => s.prepareMs);
  const scene = useSceneConfig();
  const statsOpen = useViewerStore((s) => s.statsOpen);
  const setStatsOpen = useViewerStore((s) => s.setStatsOpen);

  const rows: [string, string][] = [
    ["FPS", `${stats.fps}`],
    ["프레임", `${stats.frameMs} ms`],
    ["드로콜", `${stats.drawCalls}`],
    ["삼각형", stats.triangles.toLocaleString()],
    ["지오메트리", `${stats.geometries}`],
    ["텍스처", `${stats.textures}`],
    ...(prepareMs !== undefined ? ([["준비 시간", `${(prepareMs / 1000).toFixed(1)} s`]] as [string, string][]) : []),
  ];

  // 접었다 펼 수 있다. 처음 상태는 장면 진입 때 정한다(단독 뷰어(거실)는 넓은 화면에서 펼침, 좁은 화면·2D·3D 비교 화면은 접힘).
  const open = statsOpen;
  const title = scene.standalone ? "Interior Viewer" : scene.title;
  const badge = (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${backend === "webgpu" ? "bg-emerald-400/20 text-emerald-300" : "bg-amber-400/20 text-amber-300"}`}
    >
      {backend === "webgpu" ? "WebGPU" : "WebGL 2 대체"}
    </span>
  );

  return (
    <div className="pointer-events-none absolute left-4 top-4 z-10 rounded-lg border border-white/10 bg-stone-900/75 px-3 py-2 text-xs shadow-lg backdrop-blur">
      <button className="pointer-events-auto flex items-center gap-2" onClick={() => setStatsOpen(!statsOpen)} aria-expanded={open}>
        <span className="font-semibold">{title}</span>
        {badge}
        {!open && <span className="tabular-nums text-stone-300">{stats.fps} FPS</span>}
        <span className="text-stone-400">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <>
          <dl className="mt-1.5 grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 tabular-nums">
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-stone-400">{k}</dt>
                <dd className="text-right">{v}</dd>
              </div>
            ))}
          </dl>
          {caps?.adapter && <p className="mt-1.5 max-w-48 truncate text-[10px] text-stone-500">{caps.adapter}</p>}
        </>
      )}
    </div>
  );
}
