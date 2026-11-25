"use client";

import { Canvas, extend } from "@react-three/fiber";
import * as THREE from "three/webgpu";
import { resolveDisplayMode, type SceneConfig } from "@/config/sceneTypes";
import type { BackendKind } from "@/lib/three/capabilities";
import { QUALITY_PRESETS } from "@/lib/three/quality";
import { useViewerStore } from "@/store/viewerStore";
import InteriorScene from "./InteriorScene";

// three/webgpu 클래스(노드 재질 포함)를 JSX 요소로 등록
// eslint-disable-next-line @typescript-eslint/no-explicit-any
extend(THREE as any);

/**
 * R3F Canvas + WebGPURenderer.
 * gl 비동기 팩토리에서 renderer.init()을 완료한 뒤 R3F에 넘긴다.
 * WebGPU를 쓸 수 없으면 WebGPURenderer의 WebGL 2 백엔드(forceWebGL)로 대체 실행한다.
 */
export default function InteriorCanvas({ backend, scene, resourceScene }: { backend: BackendKind; scene: SceneConfig; resourceScene?: SceneConfig }) {
  const quality = useViewerStore((s) => s.quality);
  const preset = QUALITY_PRESETS[quality];
  // 활성 장면의 기본 표시 모드 시점(거실은 기존 CAMERA 그대로)
  const camera = resolveDisplayMode(scene, scene.defaultMode).camera;
  const initialView = camera.views.find((v) => v.id === camera.defaultView) ?? camera.views[0];

  return (
    <Canvas
      className="!absolute inset-0"
      dpr={preset.dpr}
      shadows={{ enabled: true, type: THREE.PCFShadowMap }}
      camera={{ fov: camera.fov, near: camera.near, far: camera.far, position: initialView.position }}
      gl={async (props) => {
        const { setPhase, setBackend, fail } = useViewerStore.getState();
        setPhase("initializing", backend === "webgpu" ? "WebGPU 렌더러 초기화" : "WebGL 2 대체 렌더러 초기화");
        try {
          const renderer = new THREE.WebGPURenderer({
            canvas: props.canvas as HTMLCanvasElement,
            antialias: true,
            powerPreference: "high-performance",
            forceWebGL: backend === "webgl2",
          });
          await renderer.init();
          const isWebGPU = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
          setBackend(isWebGPU ? "webgpu" : "webgl2");
          return renderer;
        } catch (e) {
          fail(e);
          throw e;
        }
      }}
    >
      <InteriorScene scene={scene} resourceScene={resourceScene} />
    </Canvas>
  );
}
