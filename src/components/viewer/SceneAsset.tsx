"use client";

import { Suspense, useMemo } from "react";
import * as THREE from "three/webgpu";
import { useGLTF } from "@react-three/drei";
import type { FurnitureItem } from "@/config/interior";
import { DECODER_PATHS, LOADER_OPTIONS } from "@/lib/three/loaders";
import { useViewerStore } from "@/store/viewerStore";
import { ErrorBoundary } from "./ErrorBoundary";
import { ProceduralModel } from "./ProceduralModels";

/**
 * GLB 모델 인스턴스.
 * useGLTF 캐시의 원본 장면을 직접 배치(부모 변경)하지 않고 복제본을 사용한다.
 * 복제본은 지오메트리·재질을 원본과 공유하므로 개별 해제하지 않는다(캐시가 소유).
 */
function GltfModel({ item }: { item: FurnitureItem }) {
  const url = item.model!.url;
  const gltf = useGLTF(url, DECODER_PATHS.draco, LOADER_OPTIONS.meshopt);
  const object = useMemo(() => {
    const clone = gltf.scene.clone(true);
    clone.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = item.castShadow ?? true;
        mesh.receiveShadow = true;
      }
    });
    if (item.model?.fitToSize !== false) {
      // 설정된 크기(size)에 맞춰 균등 스케일 후 바닥 중심을 원점에 맞춘다.
      const box = new THREE.Box3().setFromObject(clone);
      const size = box.getSize(new THREE.Vector3());
      const s = Math.min(item.size[0] / (size.x || 1), item.size[1] / (size.y || 1), item.size[2] / (size.z || 1));
      const center = box.getCenter(new THREE.Vector3());
      const wrapper = new THREE.Group();
      clone.position.set(-center.x, -box.min.y, -center.z);
      wrapper.add(clone);
      wrapper.scale.setScalar(s);
      return wrapper;
    }
    return clone;
  }, [gltf, item]);
  return <primitive object={object} />;
}

export default function SceneAsset({ item }: { item: FurnitureItem }) {
  const addWarning = useViewerStore((s) => s.addWarning);
  const rotation: [number, number, number] = [0, THREE.MathUtils.degToRad(item.rotationY ?? 0), 0];
  const procedural = <ProceduralModel item={item} />;

  return (
    <group name={`asset:${item.id}`} position={item.position} rotation={rotation}>
      {item.model ? (
        <ErrorBoundary
          fallback={procedural}
          onError={() => addWarning(`모델 로딩 실패: ${item.label} (${item.model?.url}) — 기본 모델로 대체했습니다.`)}
        >
          <Suspense fallback={procedural}>
            <GltfModel item={item} />
          </Suspense>
        </ErrorBoundary>
      ) : (
        procedural
      )}
    </group>
  );
}
