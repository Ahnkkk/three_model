"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";
import { LIVING_SCENE } from "@/config/interior";
import { sceneKey, type SceneConfig } from "@/config/sceneTypes";
import { detectCapabilities } from "@/lib/three/capabilities";
import { defaultQualityFor } from "@/lib/three/quality";
import { useViewerStore } from "@/store/viewerStore";
import ControlPanel from "./ControlPanel";
import { ErrorBoundary } from "./ErrorBoundary";
import { SceneConfigContext } from "./SceneConfigContext";
import StatsPanel from "./StatsPanel";
import ViewerStatus from "./ViewerStatus";

// 3D 모듈은 브라우저에서만 로드한다(SSR 제외).
const InteriorCanvas = dynamic(() => import("./InteriorCanvas"), { ssr: false });

interface ViewerClientProps {
  /** 표시할 장면(모듈 상수로 전달). 생략하면 기존 거실 */
  scene?: SceneConfig;
  /** 컨테이너 클래스. 생략하면 기존 거실 전체 화면 */
  className?: string;
  /** 렌더링 설정 패널에 표시 모드(조감도/실내) 전환을 둘지. 바깥에서 전환 UI를 제공하면 false */
  showModeSwitch?: boolean;
  /**
   * 재질·라이트맵·환경맵을 만드는 기준 장면(편집 화면의 품질 갱신). 생략하면 scene.
   * 같은 sceneKey에서 scene만 바뀌면 형상은 바로 바뀌고, 조명은 resourceScene이 바뀔 때 다시 굽는다.
   */
  resourceScene?: SceneConfig;
}

/**
 * 클라이언트 전용 3D 로딩 경계 + 오버레이 UI.
 * 장면 키(id + revision)가 바뀔 때 장면 상태를 초기화(resetForScene)하고, 초기화가 끝난 장면에만 Canvas를 만든다.
 * → 이전 장면의 시점·밝기·로딩 단계가 새 장면에 섞이지 않는다. 같은 키에서 장면 내용만 바뀌면(편집) 상태와 Canvas를 유지한다.
 */
export default function ViewerClient({
  scene = LIVING_SCENE,
  className = "relative h-dvh w-full overflow-hidden bg-stone-900 text-stone-100",
  showModeSwitch = true,
  resourceScene,
}: ViewerClientProps) {
  const activeSceneKey = useViewerStore((s) => s.sceneKey);
  const backend = useViewerStore((s) => s.capabilities?.preferred);
  const phase = useViewerStore((s) => s.phase);
  const fail = useViewerStore((s) => s.fail);
  const key = sceneKey(scene);
  const bound = activeSceneKey === key;
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  useEffect(() => {
    let cancelled = false;
    const { resetForScene, setCapabilities, setPhase, setQuality, toggleEffect } = useViewerStore.getState();
    resetForScene(sceneRef.current);
    setPhase("detecting", "브라우저 기능 확인");
    detectCapabilities()
      .then((caps) => {
        if (cancelled) return;
        if (!caps.preferred) {
          setCapabilities(caps);
          setPhase("unsupported");
          return;
        }
        setQuality(defaultQualityFor(caps.preferred));
        if (caps.preferred === "webgl2") toggleEffect("ssr", false);
        setCapabilities(caps);
      })
      .catch((e: unknown) => {
        if (!cancelled) fail(e);
      });
    return () => {
      cancelled = true;
    };
  }, [key, fail]);

  return (
    <SceneConfigContext.Provider value={scene}>
      <div className={className}>
        {bound && backend && phase !== "unsupported" && (
          <ErrorBoundary fallback={null} onError={(e) => fail(e)}>
            <InteriorCanvas key={key} backend={backend} scene={scene} resourceScene={resourceScene} />
          </ErrorBoundary>
        )}
        {bound && <ViewerStatus />}
        {bound && phase === "ready" && (
          <>
            <ControlPanel showModeSwitch={showModeSwitch} />
            <StatsPanel />
          </>
        )}
      </div>
    </SceneConfigContext.Provider>
  );
}
