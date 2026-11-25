"use client";

import { useEffect, useState, type ReactNode } from "react";
import { availableModes, resolveDisplayMode, sceneKey, type SceneConfig } from "@/config/sceneTypes";
import { useViewerStore } from "@/store/viewerStore";
import ViewerClient from "@/components/viewer/ViewerClient";
import FloorPlanSvg from "@/components/office/FloorPlanSvg";

/**
 * 2D 배치도(SVG)와 3D 시안(R3F)을 같은 장면 데이터로 나란히 보여 주는 화면(사무실·외부 도면 공용).
 * - 조감도: 넓은 화면은 가로 2단, 좁은 화면은 세로 배치(2D → 3D). aside(요약·검증 결과)는 2D 패널 위쪽.
 * - 실내: 3D 영역을 화면 전체로 확장한다. 같은 Canvas를 그대로 키우므로(다시 만들지 않음) 리소스를 다시 준비하지 않는다.
 *   상단 "조감도" 버튼으로 바로, 또는 Esc → 확인 창으로 돌아온다.
 * 장면이 바뀌면(id 또는 revision) ViewerClient가 상태·리소스·시점을 새로 준비한다.
 */
export default function PlanViewer({
  scene,
  title,
  nav,
  toolbar,
  aside,
  planTitle = "2D 배치도",
}: {
  scene: SceneConfig;
  title: string;
  /** 머리글 오른쪽 링크 */
  nav?: ReactNode;
  /** 머리글 가운데 도구(도면 선택 등) */
  toolbar?: ReactNode;
  /** 2D 패널 위쪽 요약·검증 결과 */
  aside?: ReactNode;
  planTitle?: string;
}) {
  const expanded = useExpanded(scene);
  const setDisplayMode = useViewerStore((s) => s.setDisplayMode);
  /** Esc로 연 "조감도로 이동" 확인 창 */
  const [askAerial, setAskAerial] = useState(false);
  const confirmOpen = expanded && askAerial;
  const hasAerial = availableModes(scene).includes("aerial");

  // 전체 화면 동안 뒤쪽 페이지 스크롤을 막고, Esc로 조감도 이동 확인 창을 연다(확인 창에서 Esc는 취소).
  useEffect(() => {
    if (!expanded) return;
    const root = document.documentElement;
    const prevOverflow = root.style.overflow;
    root.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 마우스 시점(포인터 잠금)을 푸는 Esc는 잠금 해제만 한다. 확인 창은 잠금이 풀린 뒤 한 번 더 누를 때 연다.
      const { pointerLocked, pointerUnlockedAt } = useViewerStore.getState();
      if (pointerLocked || document.pointerLockElement || performance.now() - pointerUnlockedAt < 400) return;
      e.preventDefault();
      setAskAerial((open) => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      root.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
      setAskAerial(false); // 실내를 벗어나면 확인 창을 닫아 둔다(다시 들어왔을 때 남아 있지 않게).
    };
  }, [expanded]);

  return (
    <div className="flex min-h-dvh flex-col gap-3 bg-slate-100 p-3 text-slate-900 lg:h-dvh">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-300 bg-white px-4 py-2 shadow-sm">
        <h1 className="text-base font-bold text-[#14305c]">{title}</h1>
        {toolbar}
        {nav && <nav className="flex items-center gap-2">{nav}</nav>}
      </header>

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.25fr)]">
        {/* 2D 배치도 + 요약 */}
        <section className="flex flex-col gap-2 rounded-xl border border-slate-300 bg-white p-3 shadow-sm lg:min-h-0">
          <PanelTitle>{planTitle}</PanelTitle>
          {aside}
          <div className="min-h-64 flex-1 lg:min-h-0">
            <FloorPlanSvg scene={scene} />
          </div>
        </section>

        {/* 3D 배치 시안 */}
        <section className="flex h-[72vh] flex-col rounded-xl border border-slate-300 bg-white p-3 shadow-sm lg:h-auto lg:min-h-0">
          <div className="flex items-center justify-between gap-2">
            <PanelTitle>3D 배치 시안</PanelTitle>
            {!expanded && <DisplayModeSwitch scene={scene} tone="light" />}
          </div>
          {/* ViewerClient는 항상 같은 위치에 두고 감싸는 요소의 배치만 바꾼다(전환 시 Canvas 유지). */}
          <div className={expanded ? "fixed inset-0 z-50" : "relative mt-2 min-h-0 flex-1"}>
            <ViewerClient
              scene={scene}
              showModeSwitch={false}
              className={`absolute inset-0 overflow-hidden bg-[#eef1f4] text-stone-100 ${expanded ? "" : "rounded-lg"}`}
            />
            {expanded && (
              <div className="absolute left-1/2 top-[6.5rem] z-20 flex -translate-x-1/2 flex-col items-center gap-1 sm:top-4">
                <DisplayModeSwitch scene={scene} tone="dark" />
                <p className="hidden rounded-md bg-stone-900/60 px-2 py-0.5 text-[11px] text-stone-200 backdrop-blur xl:block">
                  클릭 후 마우스·방향키로 시점 · 휠 확대·축소 · WASD 이동 · Shift 빠르게 · Space 점프 · Esc 마우스 해제 → 한 번 더 누르면 조감도 이동
                </p>
              </div>
            )}
            {confirmOpen && hasAerial && (
              <ConfirmDialog
                title="조감도로 이동할까요?"
                message={`실내 보기를 닫고 ${scene.title} 전체 조감도로 돌아갑니다.`}
                onCancel={() => setAskAerial(false)}
                onConfirm={() => {
                  setAskAerial(false);
                  setDisplayMode(scene, "aerial");
                }}
              />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * 확인·취소 창(실내 화면 위). 바깥(어두운 배경)을 누르거나 Esc를 누르면 취소(Esc는 위 키 처리에서 닫는다).
 * 확인 버튼에 포커스를 두어 Enter·Space로 확인한다(이 창 안의 키는 보행 조작으로 쓰지 않는다).
 */
function ConfirmDialog({ title, message, onConfirm, onCancel }: { title: string; message: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
        className="w-full max-w-sm rounded-xl border border-white/10 bg-stone-900/95 p-5 text-stone-100 shadow-2xl break-keep"
      >
        <h2 id="confirm-dialog-title" className="text-base font-semibold">
          {title}
        </h2>
        <p id="confirm-dialog-message" className="mt-1.5 text-sm text-stone-300">
          {message}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg border border-white/15 px-4 py-1.5 text-sm text-stone-200 hover:bg-white/10">
            취소
          </button>
          <button
            type="button"
            autoFocus
            onClick={onConfirm}
            className="rounded-lg bg-amber-400 px-4 py-1.5 text-sm font-semibold text-stone-900 hover:bg-amber-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"
          >
            확인
          </button>
        </div>
      </div>
    </div>
  );
}

/** 장면이 실내 모드인지(= 3D 전체 화면). 장면 진입 초기화 전의 이전 상태는 무시한다. */
function useExpanded(scene: SceneConfig): boolean {
  const key = sceneKey(scene);
  return useViewerStore((s) => s.sceneKey === key && s.displayMode === "interior");
}

/**
 * 조감도/실내 전환. light = 패널 머리글(조감도 화면), dark = 3D 전체 화면 위 오버레이.
 * 리소스 준비가 끝나기 전에는 누를 수 없고, 전체 화면에서는 오류가 나도 조감도로 돌아갈 수 있게 둔다.
 */
function DisplayModeSwitch({ scene, tone }: { scene: SceneConfig; tone: "light" | "dark" }) {
  const key = sceneKey(scene);
  const displayMode = useViewerStore((s) => s.displayMode);
  const setDisplayMode = useViewerStore((s) => s.setDisplayMode);
  const ready = useViewerStore((s) => s.sceneKey === key && s.phase === "ready");
  const expanded = useExpanded(scene);
  const modes = availableModes(scene);

  const light = tone === "light";
  return (
    <div
      role="radiogroup"
      aria-label="표시 모드"
      className={`flex rounded-lg p-0.5 ${light ? "border border-slate-300 bg-slate-100" : "border border-white/10 bg-stone-900/80 shadow-lg backdrop-blur"}`}
    >
      {modes.map((m) => {
        const active = displayMode === m;
        return (
          <button
            key={m}
            role="radio"
            aria-checked={active}
            disabled={!ready && !expanded}
            onClick={() => {
              if (!active) setDisplayMode(scene, m);
            }}
            className={`rounded-md px-3.5 py-1 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              active
                ? light
                  ? "bg-[#14305c] text-white shadow-sm"
                  : "bg-stone-100 text-stone-900"
                : light
                  ? "text-slate-600 hover:bg-white hover:text-slate-900"
                  : "text-stone-200 hover:bg-white/10"
            }`}
          >
            {resolveDisplayMode(scene, m).label}
          </button>
        );
      })}
    </div>
  );
}

export function PanelTitle({ children }: { children: ReactNode }) {
  return <h2 className="w-fit shrink-0 rounded-lg bg-[#14305c] px-3 py-1 text-sm font-bold text-white">{children}</h2>;
}
