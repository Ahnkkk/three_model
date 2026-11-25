"use client";

import { useProgress } from "@react-three/drei";
import { useViewerStore, type ViewerPhase } from "@/store/viewerStore";

const PHASES: { id: ViewerPhase; label: string }[] = [
  { id: "detecting", label: "기능 확인" },
  { id: "initializing", label: "렌더러 초기화" },
  { id: "building", label: "리소스 생성" },
  { id: "compiling", label: "셰이더 컴파일" },
];

/** 로딩 진행 상태, 지원 불가·오류 안내, 경고 표시 */
export default function ViewerStatus() {
  const phase = useViewerStore((s) => s.phase);
  const detail = useViewerStore((s) => s.phaseDetail);
  const error = useViewerStore((s) => s.error);
  const caps = useViewerStore((s) => s.capabilities);
  const warnings = useViewerStore((s) => s.warnings);
  const dismissWarnings = useViewerStore((s) => s.dismissWarnings);
  const refreshing = useViewerStore((s) => s.refreshing);
  const { active: assetsLoading, progress, item } = useProgress();

  if (phase === "unsupported") {
    return (
      <Overlay>
        <h2 className="text-lg font-semibold">이 브라우저에서는 3D 화면을 표시할 수 없습니다</h2>
        <p className="mt-2 text-sm text-stone-300">
          WebGPU와 WebGL 2를 모두 사용할 수 없습니다. 최신 Chrome·Edge·Safari·Firefox에서 다시 열어 주세요. 하드웨어 가속이 꺼져 있다면 브라우저
          설정에서 켜야 합니다.
        </p>
      </Overlay>
    );
  }

  if (phase === "error") {
    return (
      <Overlay>
        <h2 className="text-lg font-semibold text-red-300">3D 화면을 준비하지 못했습니다</h2>
        <p className="mt-2 break-all text-sm text-stone-300">{error}</p>
        {caps?.webgpu && !caps.forcedWebGL && (
          <p className="mt-2 text-xs text-stone-400">
            주소 뒤에 <code className="rounded bg-stone-800 px-1">?backend=webgl</code> 를 붙이면 WebGL 2 대체 경로로 실행할 수 있습니다.
          </p>
        )}
        <button
          className="mt-4 rounded-md bg-stone-100 px-3 py-1.5 text-sm font-medium text-stone-900 hover:bg-white"
          onClick={() => window.location.reload()}
        >
          다시 시도
        </button>
      </Overlay>
    );
  }

  const index = PHASES.findIndex((p) => p.id === phase);
  const loading = phase !== "ready";

  return (
    <>
      {loading && (
        <Overlay>
          <div className="flex items-center gap-3">
            <span className="size-4 animate-spin rounded-full border-2 border-stone-500 border-t-stone-100" />
            <h2 className="text-base font-semibold">실내 공간 준비 중</h2>
          </div>
          <ol className="mt-4 space-y-1.5 text-sm">
            {PHASES.map((p, i) => (
              <li key={p.id} className={i < index ? "text-stone-500 line-through" : i === index ? "text-stone-100" : "text-stone-500"}>
                {i + 1}. {p.label}
                {i === index && detail ? <span className="ml-2 text-xs text-stone-400">{detail}</span> : null}
              </li>
            ))}
          </ol>
          {assetsLoading && (
            <div className="mt-4">
              <div className="h-1.5 overflow-hidden rounded bg-stone-700">
                <div className="h-full bg-amber-300 transition-[width]" style={{ width: `${progress}%` }} />
              </div>
              <p className="mt-1 truncate text-xs text-stone-400">
                모델 로딩 {Math.round(progress)}% {item}
              </p>
            </div>
          )}
        </Overlay>
      )}
      {refreshing && !loading && (
        <div role="status" className="pointer-events-none absolute bottom-16 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full bg-stone-900/80 px-3 py-1 text-xs text-stone-100 shadow-lg backdrop-blur">
          <span className="size-3 animate-spin rounded-full border-2 border-stone-500 border-t-stone-100" />
          조명 갱신 중(이전 조명으로 표시)
        </div>
      )}
      {warnings.length > 0 && (
        <div className="absolute left-1/2 top-4 z-30 w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 rounded-lg border border-amber-400/40 bg-stone-900/90 p-3 text-sm shadow-lg backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <ul className="space-y-1 text-amber-200">
              {warnings.map((w) => (
                <li key={w}>⚠ {w}</li>
              ))}
            </ul>
            <button className="shrink-0 text-xs text-stone-400 hover:text-stone-100" onClick={dismissWarnings}>
              닫기
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-stone-950/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border border-stone-700 bg-stone-900/95 p-6 shadow-2xl">{children}</div>
    </div>
  );
}
