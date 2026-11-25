"use client";

import { createContext, useContext, useMemo } from "react";
import { LIVING_SCENE } from "@/config/interior";
import { resolveDisplayMode, type ResolvedScene, type SceneConfig } from "@/config/sceneTypes";
import { useViewerStore } from "@/store/viewerStore";

/**
 * 장면 설정 전달 경계.
 * 컴포넌트는 전역 상수(ROOM·FURNITURE·LIGHTING·CAMERA) 대신 이 컨텍스트에서 장면 설정을 읽는다.
 * Provider가 없으면 기존 거실 설정을 사용한다.
 */
export const SceneConfigContext = createContext<SceneConfig>(LIVING_SCENE);

export function useSceneConfig(): SceneConfig {
  return useContext(SceneConfigContext);
}

/** 장면 + 현재 표시 모드(조감도/실내)를 적용한 값 */
export function useResolvedScene(): ResolvedScene {
  const scene = useSceneConfig();
  const mode = useViewerStore((s) => s.displayMode);
  return useMemo(() => {
    const effectiveMode = scene.modes?.[mode] ? mode : scene.defaultMode;
    return { ...scene, mode: effectiveMode, view: resolveDisplayMode(scene, effectiveMode) };
  }, [scene, mode]);
}
