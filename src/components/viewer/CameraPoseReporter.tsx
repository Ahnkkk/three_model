"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three/webgpu";
import { publishCameraPose, type CameraPose } from "@/lib/three/cameraPose";

/** 카메라의 평면 위치·시선·수평 시야각을 미니맵에 알린다(바뀐 프레임에만). */
export default function CameraPoseReporter() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const dir = useMemo(() => new THREE.Vector3(), []);
  const last = useRef<CameraPose | null>(null);

  // 언마운트(장면 전환·개발 모드 이펙트 재실행) 시 위치를 지우고, 다음 프레임에 다시 알리도록 기억값도 비운다.
  useEffect(
    () => () => {
      last.current = null;
      publishCameraPose(null);
    },
    [],
  );

  useFrame(() => {
    camera.getWorldDirection(dir);
    const aspect = size.width / Math.max(1, size.height);
    const pose: CameraPose = {
      x: camera.position.x,
      z: camera.position.z,
      heading: Math.atan2(dir.z, dir.x),
      hfov: 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * aspect),
    };
    const p = last.current;
    if (p && Math.abs(p.x - pose.x) < 1e-3 && Math.abs(p.z - pose.z) < 1e-3 && Math.abs(p.heading - pose.heading) < 1e-3 && Math.abs(p.hfov - pose.hfov) < 1e-3) return;
    last.current = pose;
    publishCameraPose(pose);
  });
  return null;
}
