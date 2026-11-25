"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useThree } from "@react-three/fiber";
import type * as THREE from "three/webgpu";
import { sceneKey, type SceneConfig } from "@/config/sceneTypes";
import { BakeCancelledError } from "@/lib/three/lightmapBaker";
import { buildSceneResources, type SceneResources } from "@/lib/three/sceneResources";
import { useViewerStore } from "@/store/viewerStore";
import OfficeAnnotations from "@/components/office/OfficeAnnotations";
import { ChairInstances, INSTANCED_KINDS } from "@/components/office/OfficeModels";
import OfficeShell from "@/components/office/OfficeShell";
import CameraControls from "./CameraControls";
import CameraPoseReporter from "./CameraPoseReporter";
import Effects from "./Effects";
import Lighting from "./Lighting";
import Reflections from "./Reflections";
import RoomShell from "./RoomShell";
import SceneAsset from "./SceneAsset";
import { SceneConfigContext } from "./SceneConfigContext";
import { SceneResourcesContext } from "./SceneResourcesContext";

/**
 * 렌더러별 사전 컴파일 직렬화.
 * WebGPURenderer.compileAsync는 동시에 여러 번 호출되면 내부 상태가 깨지므로
 * (개발 모드 StrictMode의 이펙트 재실행 등) 이전 호출이 끝난 뒤 실행한다.
 */
const compileQueue = new WeakMap<object, Promise<unknown>>();

function compileSerialized(gl: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera): Promise<unknown> {
  const prev = compileQueue.get(gl) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => gl.compileAsync(scene, camera));
  compileQueue.set(gl, next);
  return next;
}

/** 장면이 모두 마운트된 뒤 셰이더를 미리 컴파일하고 준비 완료로 전환한다. */
function SceneReady({ onReady }: { onReady: () => void }) {
  const gl = useThree((s) => s.gl) as unknown as THREE.WebGPURenderer;
  const scene = useThree((s) => s.scene) as unknown as THREE.Scene;
  const camera = useThree((s) => s.camera);
  const setPhase = useViewerStore((s) => s.setPhase);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    let cancelled = false;
    setPhase("compiling", "셰이더 컴파일");
    compileSerialized(gl, scene, camera)
      .catch((e: unknown) => {
        // 사전 컴파일은 첫 프레임 끊김을 줄이는 최적화 단계다. 실패해도 렌더링 시점에 다시 컴파일되므로 진행한다.
        console.warn("[SceneReady] 사전 컴파일 실패, 렌더링 시점 컴파일로 진행합니다.", e);
      })
      .then(() => {
        if (cancelled) return;
        setPhase("ready");
        onReadyRef.current();
      });
    return () => {
      cancelled = true;
    };
  }, [gl, scene, camera, setPhase]);
  return null;
}

/**
 * 장면 렌더링 + 공유 리소스 소유.
 * - scene: 형상(벽·가구·개구부·조명 위치)을 그리는 현재 장면. 편집 중에는 바뀔 때마다 바로 반영한다.
 * - resourceScene: 재질·라이트맵·환경맵을 만드는 기준 장면(품질 갱신). 생략하면 scene.
 *   첫 준비 뒤 resourceScene이 바뀌면 이전 리소스로 계속 그리면서 새 리소스를 시간 조각으로 굽고, 끝나면 교체한다.
 *   굽는 도중 다시 바뀌면 진행 중인 베이크를 취소한다.
 */
export default function InteriorScene({ scene, resourceScene = scene }: { scene: SceneConfig; resourceScene?: SceneConfig }) {
  const gl = useThree((s) => s.gl) as unknown as THREE.WebGPURenderer;
  const setPhase = useViewerStore((s) => s.setPhase);
  const setPrepareMs = useViewerStore((s) => s.setPrepareMs);
  const setRefreshing = useViewerStore((s) => s.setRefreshing);
  const addWarning = useViewerStore((s) => s.addWarning);
  const fail = useViewerStore((s) => s.fail);
  const [resources, setResources] = useState<SceneResources | null>(null);
  const hasResources = useRef(false);
  const startedAt = useRef(0);

  // 공유 리소스 생성(이 컴포넌트가 소유). 기준 장면이 바뀌면 진행 중인 생성은 취소·폐기한다.
  useEffect(() => {
    let cancelled = false;
    const refresh = hasResources.current;
    if (refresh) {
      setRefreshing(true);
    } else {
      startedAt.current = performance.now();
      setPhase("building", "리소스 준비");
    }
    buildSceneResources(
      gl,
      resourceScene,
      (message) => {
        if (!cancelled && !refresh) setPhase("building", message);
      },
      { isCancelled: () => cancelled },
    )
      .then((res) => {
        if (cancelled) {
          res.dispose();
          return;
        }
        hasResources.current = true;
        setResources(res);
        if (refresh) setRefreshing(false);
      })
      .catch((e: unknown) => {
        if (cancelled || e instanceof BakeCancelledError) return;
        if (!refresh) {
          fail(e);
          return;
        }
        setRefreshing(false);
        addWarning(`조명 품질 갱신 실패: ${e instanceof Error ? e.message : String(e)} — 이전 조명으로 표시합니다.`);
      });
    return () => {
      cancelled = true;
      if (refresh) setRefreshing(false);
    };
  }, [gl, resourceScene, setPhase, setRefreshing, addWarning, fail]);

  // 표시 중인 리소스 해제: 새 리소스로 교체되어 화면에 반영된 뒤, 또는 언마운트될 때
  useEffect(() => () => resources?.dispose(), [resources]);

  // 같은 부품을 반복하는 의자는 인스턴싱으로, 나머지는 개별 배치(GLB 교체 가능)
  const { instanced, individual } = useMemo(() => {
    const inst = scene.furniture.filter((f) => INSTANCED_KINDS.has(f.kind) && !f.model);
    return { instanced: inst, individual: scene.furniture.filter((f) => !inst.includes(f)) };
  }, [scene]);

  if (!resources || resources.sceneKey !== sceneKey(scene)) return null;

  return (
    <SceneConfigContext.Provider value={scene}>
      <SceneResourcesContext.Provider value={resources}>
        <Suspense fallback={null}>
          {scene.shell === "living" ? <RoomShell /> : <OfficeShell />}
          {individual.map((item) => (
            <SceneAsset key={item.id} item={item} />
          ))}
          {instanced.length > 0 && <ChairInstances items={instanced} />}
          <Lighting />
          <Reflections />
          <SceneReady onReady={() => setPrepareMs(Math.round(performance.now() - startedAt.current))} />
        </Suspense>
        {scene.annotations.length > 0 && <OfficeAnnotations />}
        <CameraControls />
        <CameraPoseReporter />
        <Effects />
      </SceneResourcesContext.Provider>
    </SceneConfigContext.Provider>
  );
}
