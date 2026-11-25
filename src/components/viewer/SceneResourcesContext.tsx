"use client";

import { createContext, useContext, useEffect, useMemo } from "react";
import type { BufferGeometry } from "three/webgpu";
import type { SceneResources } from "@/lib/three/sceneResources";

export const SceneResourcesContext = createContext<SceneResources | null>(null);

export function useSceneResources(): SceneResources {
  const ctx = useContext(SceneResourcesContext);
  if (!ctx) throw new Error("SceneResourcesContext가 없습니다.");
  return ctx;
}

/**
 * 컴포넌트가 소유하는 지오메트리를 생성하고 언마운트 시 해제한다.
 * (R3F는 prop으로 전달된 geometry를 자동 해제하지 않는다.)
 */
export function useOwnedGeometries<T extends Record<string, BufferGeometry>>(factory: () => T, deps: unknown[]): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const geometries = useMemo(factory, deps);
  useEffect(() => () => Object.values(geometries).forEach((g) => g.dispose()), [geometries]);
  return geometries;
}
