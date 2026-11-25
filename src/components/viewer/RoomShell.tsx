"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import type { WallId, WallOpening } from "@/config/sceneTypes";
import { metricBox } from "@/lib/three/geometry";
import { createSurfaceGeometry, getSurfaceFrames, surfacePoint, type SurfaceFrame } from "@/lib/three/roomSurfaces";
import { useSceneConfig } from "./SceneConfigContext";
import { useOwnedGeometries, useSceneResources } from "./SceneResourcesContext";

/** 표면 로컬 좌표계(x=벽 방향, y=위, z=실내 방향) → 월드 변환 */
function frameMatrix(frame: SurfaceFrame, su: number, sv: number): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeBasis(frame.uAxis, frame.vAxis, frame.normal);
  m.setPosition(surfacePoint(frame, su, sv));
  return m;
}

function MatrixGroup({ matrix, children }: { matrix: THREE.Matrix4; children: React.ReactNode }) {
  const props = useMemo(() => {
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    matrix.decompose(position, quaternion, scale);
    return { position, quaternion };
  }, [matrix]);
  return (
    <group position={props.position} quaternion={props.quaternion}>
      {children}
    </group>
  );
}

/** 벽 하단 걸레받이. 문 위치는 비워 둔다. */
function Baseboards({ frames }: { frames: SurfaceFrame[] }) {
  const { materials } = useSceneResources();
  const { room, furniture } = useSceneConfig();
  const h = room.baseboardHeight;
  const depth = 0.014;
  const segments = useMemo(() => {
    const out: { key: string; matrix: THREE.Matrix4; length: number }[] = [];
    for (const frame of frames.filter((f) => f.id !== "floor" && f.id !== "ceiling")) {
      const gaps = furniture.filter((it) => it.kind === "door")
        .map((it) => {
          const p = new THREE.Vector3(...it.position);
          const distToWall = Math.abs(p.clone().sub(frame.origin).dot(frame.normal));
          if (distToWall > 0.1) return null;
          const u = p.sub(frame.origin).dot(frame.uAxis);
          return [u - it.size[0] / 2 - 0.06, u + it.size[0] / 2 + 0.06] as [number, number];
        })
        .filter((g): g is [number, number] => g !== null)
        .sort((a, b) => a[0] - b[0]);
      let start = 0;
      const ranges: [number, number][] = [];
      for (const [g0, g1] of gaps) {
        if (g0 > start) ranges.push([start, g0]);
        start = Math.max(start, g1);
      }
      if (start < frame.uLength) ranges.push([start, frame.uLength]);
      ranges.forEach(([a, b], i) => {
        const m = frameMatrix(frame, (a + b) / 2, h / 2);
        m.multiply(new THREE.Matrix4().makeTranslation(0, 0, depth / 2));
        out.push({ key: `${frame.id}-${i}`, matrix: m, length: b - a });
      });
    }
    return out;
  }, [frames, h, furniture]);

  const geos = useOwnedGeometries(
    () => Object.fromEntries(segments.map((s) => [s.key, metricBox(s.length, h, depth)])),
    [segments, h],
  );

  return (
    <>
      {segments.map((s) => (
        <MatrixGroup key={s.key} matrix={s.matrix}>
          <mesh geometry={geos[s.key]} material={materials.baseboard} receiveShadow />
        </MatrixGroup>
      ))}
    </>
  );
}

/** 창: 개구부 안쪽 벽 두께면, 창틀, 유리, 창대 */
function WindowUnit({ frame, opening }: { frame: SurfaceFrame; opening: WallOpening }) {
  const { materials } = useSceneResources();
  const t = useSceneConfig().room.wallThickness;
  const { width: w, height: h } = opening;
  const matrix = useMemo(() => frameMatrix(frame, opening.center, opening.bottom + h / 2), [frame, opening, h]);
  const frameDepth = -t * 0.55;
  const bar = 0.05;

  const geos = useOwnedGeometries(
    () => ({
      jambSide: metricBox(0.02, h + 0.04, t),
      jambTopBottom: metricBox(w + 0.04, 0.02, t),
      sill: metricBox(w + 0.12, 0.03, t + 0.07),
      frameSide: metricBox(bar, h, 0.06),
      frameTopBottom: metricBox(w, bar, 0.06),
      mullion: metricBox(0.04, h - bar * 2, 0.05),
      transom: metricBox(w - bar * 2, 0.04, 0.05),
      glass: new THREE.PlaneGeometry(w, h),
    }),
    [w, h, t],
  );

  return (
    <MatrixGroup matrix={matrix}>
      {/* 개구부 벽 두께면 */}
      <mesh geometry={geos.jambSide} material={materials.wallPlaster} position={[-w / 2 - 0.01, 0, -t / 2]} receiveShadow castShadow />
      <mesh geometry={geos.jambSide} material={materials.wallPlaster} position={[w / 2 + 0.01, 0, -t / 2]} receiveShadow castShadow />
      <mesh geometry={geos.jambTopBottom} material={materials.wallPlaster} position={[0, h / 2 + 0.01, -t / 2]} receiveShadow castShadow />
      <mesh geometry={geos.sill} material={materials.walnut} position={[0, -h / 2 - 0.015, -t / 2 + 0.035]} receiveShadow castShadow />
      {/* 창틀 */}
      <group position={[0, 0, frameDepth]}>
        <mesh geometry={geos.frameSide} material={materials.windowFrame} position={[-w / 2 + bar / 2, 0, 0]} castShadow receiveShadow />
        <mesh geometry={geos.frameSide} material={materials.windowFrame} position={[w / 2 - bar / 2, 0, 0]} castShadow receiveShadow />
        <mesh geometry={geos.frameTopBottom} material={materials.windowFrame} position={[0, h / 2 - bar / 2, 0]} castShadow receiveShadow />
        <mesh geometry={geos.frameTopBottom} material={materials.windowFrame} position={[0, -h / 2 + bar / 2, 0]} castShadow receiveShadow />
        <mesh geometry={geos.mullion} material={materials.windowFrame} castShadow receiveShadow />
        <mesh geometry={geos.transom} material={materials.windowFrame} position={[0, h / 2 - 0.5, 0]} castShadow receiveShadow />
        <mesh geometry={geos.glass} material={materials.glass} renderOrder={10} />
      </group>
    </MatrixGroup>
  );
}

/** 창밖 하늘·풍경 배경(조명 계산 제외, 그림자 없음) */
function SkyBackdrop() {
  const { sky } = useSceneResources();
  const { room, lighting } = useSceneConfig();
  const { geometry, material } = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial({ map: sky });
    m.color.setScalar(lighting.skyLuminance);
    return { geometry: new THREE.PlaneGeometry(16, 8), material: m };
  }, [sky, lighting.skyLuminance]);
  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );
  // west 벽 바깥, +x(실내)를 향하도록 배치
  return <mesh geometry={geometry} material={material} position={[-room.width / 2 - 3.5, 1.6, -0.4]} rotation={[0, Math.PI / 2, 0]} />;
}

export default function RoomShell() {
  const { surfaceMaterials } = useSceneResources();
  const { room } = useSceneConfig();
  const frames = useMemo(() => getSurfaceFrames(room), [room]);
  const geos = useOwnedGeometries(() => Object.fromEntries(frames.map((f) => [f.id, createSurfaceGeometry(f, room)])), [frames, room]);

  return (
    <group name="room-shell">
      {frames.map((f) => (
        <mesh
          key={f.id}
          name={`surface:${f.id}`}
          geometry={geos[f.id]}
          material={surfaceMaterials[f.id]}
          receiveShadow
          castShadow={f.id !== "floor"}
        />
      ))}
      {room.openings.filter((o) => o.kind === "window").map((o) => (
        <WindowUnit key={o.id} frame={frames.find((f) => f.id === (o.wall as WallId))!} opening={o} />
      ))}
      <Baseboards frames={frames} />
      <SkyBackdrop />
    </group>
  );
}
