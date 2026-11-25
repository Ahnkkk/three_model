"use client";

import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three/webgpu";
import { useViewerStore } from "@/store/viewerStore";
import { useResolvedScene } from "./SceneConfigContext";
import { useSceneResources } from "./SceneResourcesContext";

/**
 * 기본 반사(실내형 환경맵)와 장면 배경 연결.
 *
 * - 가구 등 일반 오브젝트: scene.environment(확산 + 반사)
 * - 라이트맵이 켜진 방 표면: 재질별 envMap을 지정하고 강도를 낮춰 간접 확산광 중복을 줄인다.
 *   (three.js 노드 재질은 material.envMap이 있으면 envMapIntensity를, 없으면 scene.environmentIntensity를 사용)
 * - 표시 모드(조감도/실내)마다 다른 환경맵·배경을 사용한다.
 * - 지역 반사 프로브·SSR은 후속 단계(Effects의 실험 SSR 참고).
 */
export default function Reflections() {
  const scene3 = useThree((s) => s.scene);
  const scene = useResolvedScene();
  const { environment, surfaceMaterials, floorOverlays } = useSceneResources();
  const envOn = useViewerStore((s) => s.effects.environment);
  const lampsOn = useViewerStore((s) => s.effects.lamps);
  const lightmapOn = useViewerStore((s) => s.effects.lightmap);
  const intensity = useViewerStore((s) => s.environmentIntensity) * scene.view.environmentScale;
  const { environment: envCfg } = scene.lighting;

  useEffect(() => {
    const tex = environment.get(scene.view.bakeVariant, lampsOn);
    scene3.environment = tex;
    scene3.environmentIntensity = envOn ? intensity : 0;

    const surfaceIntensity = !envOn ? 0 : lightmapOn ? envCfg.roomSurfaceIntensityWithLightmap * (intensity / envCfg.intensity) : intensity;
    for (const m of [...Object.values(surfaceMaterials), ...Object.values(floorOverlays)] as THREE.MeshStandardNodeMaterial[]) {
      if (m.envMap !== tex) {
        m.envMap = tex;
        m.needsUpdate = true;
      }
      m.envMapIntensity = surfaceIntensity;
    }
  }, [scene3, environment, surfaceMaterials, floorOverlays, envOn, lampsOn, lightmapOn, intensity, envCfg, scene.view.bakeVariant]);

  // 장면 배경(조감도는 밝은 프레젠테이션 배경)
  const background = scene.view.background;
  useEffect(() => {
    scene3.background = background ? new THREE.Color(background) : null;
    return () => {
      scene3.background = null;
    };
  }, [scene3, background]);

  useEffect(
    () => () => {
      scene3.environment = null;
    },
    [scene3],
  );

  return null;
}
