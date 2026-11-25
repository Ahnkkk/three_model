"use client";

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { MATERIALS, type MaterialDef } from "@/config/materials";
import { QUALITY_PRESETS } from "@/lib/three/quality";
import { useViewerStore } from "@/store/viewerStore";
import { useResolvedScene } from "./SceneConfigContext";
import { useSceneResources } from "./SceneResourcesContext";

/**
 * 직접광(태양·램프)과 베이크된 간접광(라이트맵) 연결.
 *
 * - 태양: 방향광 + 그림자(유일한 그림자 광원). 위치·세기는 표시 모드(실내/조감도)별 설정을 따른다.
 *   그림자 범위는 방 전체 bounds에 맞춰 계산한다(설정에 cameraExtent가 있으면 그 값을 사용).
 * - 램프: 점광원(그림자 없음). 켜짐/꺼짐에 따라 미리 베이크한 라이트맵 세트를 교체한다.
 * - 라이트맵: 방 표면 재질에 uv1 채널로 연결. 끄면 환경광만으로 간접광을 근사한다.
 */
export default function Lighting() {
  const scene = useResolvedScene();
  const { materials, surfaceMaterials, floorOverlays, lightmapFor } = useSceneResources();
  const shadows = useViewerStore((s) => s.effects.shadows);
  const lampsOn = useViewerStore((s) => s.effects.lamps);
  const lightmapOn = useViewerStore((s) => s.effects.lightmap);
  const lightmapIntensity = useViewerStore((s) => s.lightmapIntensity);
  const quality = useViewerStore((s) => s.quality);
  const shadowMapSize = QUALITY_PRESETS[quality].shadowMapSize;

  const sunRef = useRef<THREE.DirectionalLight>(null);
  const target = useMemo(() => new THREE.Object3D(), []);
  const sun = scene.view.sun;
  const { room } = scene;

  // 태양 그림자 설정(해상도는 품질 프리셋, 범위는 방 크기)
  useEffect(() => {
    const light = sunRef.current;
    if (!light) return;
    light.target = target;
    const extent = sun.shadow.cameraExtent ?? 0.5 * Math.hypot(room.width, room.depth, room.height) + 0.6;
    const distance = new THREE.Vector3(...sun.position).distanceTo(new THREE.Vector3(...sun.target));
    const cam = light.shadow.camera;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.near = Math.max(0.5, distance - extent - 2);
    cam.far = distance + extent + 2;
    cam.updateProjectionMatrix();
    light.shadow.bias = sun.shadow.bias;
    light.shadow.normalBias = sun.shadow.normalBias;
    light.shadow.mapSize.set(shadowMapSize, shadowMapSize);
  }, [target, shadowMapSize, sun, room]);

  // 램프 발광 표면(장면별 목록)
  useEffect(() => {
    for (const id of scene.lighting.emissiveMaterials) {
      const base = (MATERIALS[id] as MaterialDef).emissiveIntensity ?? 1;
      materials[id].emissiveIntensity = lampsOn ? base : id === "bulb" ? 0.05 : 0;
    }
  }, [materials, lampsOn, scene.lighting.emissiveMaterials]);

  // 라이트맵 연결(표면 → 텍스처, uv1, 강도). 표시 모드·조명 상태별 베이크 결과를 교체한다.
  useEffect(() => {
    const set = lightmapFor(scene.view.bakeVariant, lampsOn);
    const targets: [keyof typeof surfaceMaterials, THREE.MeshStandardNodeMaterial][] = [
      ...(Object.entries(surfaceMaterials) as [keyof typeof surfaceMaterials, THREE.MeshStandardNodeMaterial][]),
      // 바닥 마감 영역은 바닥 라이트맵을 같은 uv1로 사용
      ...Object.values(floorOverlays).map((m) => ["floor", m] as [keyof typeof surfaceMaterials, THREE.MeshStandardNodeMaterial]),
    ];
    for (const [id, m] of targets) {
      const next = lightmapOn ? set[id] : null;
      if (m.lightMap !== next) {
        m.lightMap = next;
        m.needsUpdate = true;
      }
      m.lightMapIntensity = lightmapIntensity;
    }
  }, [surfaceMaterials, floorOverlays, lightmapFor, scene.view.bakeVariant, lampsOn, lightmapOn, lightmapIntensity]);

  const lampScale = scene.view.lampScale;
  return (
    <>
      <primitive object={target} position={sun.target} />
      <directionalLight ref={sunRef} position={sun.position} color={sun.color} intensity={sun.intensity} castShadow={shadows} />
      {scene.lighting.lamps.map((lamp) => (
        <pointLight
          key={lamp.id}
          name={lamp.id}
          position={lamp.position}
          color={lamp.color}
          intensity={lampsOn ? lamp.intensity * lampScale : 0}
          decay={2}
          distance={0}
          castShadow={shadows && lamp.castShadow}
        />
      ))}
    </>
  );
}
