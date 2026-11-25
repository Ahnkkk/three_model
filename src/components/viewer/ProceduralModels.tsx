"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import type { FurnitureItem, FurnitureKind } from "@/config/sceneTypes";
import { metricBox, metricCylinder, metricLathe, metricRoundedBox, metricSphere } from "@/lib/three/geometry";
import { OFFICE_MODELS } from "@/components/office/OfficeModels";
import { useSceneConfig } from "./SceneConfigContext";
import { useOwnedGeometries, useSceneResources } from "./SceneResourcesContext";

/**
 * 코드로 만든 가구 모델(에셋 확보 전 배치·크기·조명 검증용).
 * 로컬 좌표: 원점 = 바닥 중심, 정면 = +z, 크기는 item.size를 따른다.
 */

interface ModelProps {
  item: FurnitureItem;
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------ 소파·암체어 ------------------------------ */

function Sofa({ item, seats, upholstery }: ModelProps & { seats: number; upholstery: "fabric" | "leather" }) {
  const { materials, tinted } = useSceneResources();
  const [w, h, d] = item.size;
  const legH = 0.08;
  const arm = seats > 1 ? 0.17 : 0.13;
  const backD = 0.2;
  const seatTop = 0.44;
  const seatW = (w - arm * 2) / seats;
  const fabric = item.variant?.color ? tinted(upholstery, item.variant.color) : materials[upholstery];

  const g = useOwnedGeometries(
    () => ({
      leg: metricCylinder(0.022, 0.018, legH, 12),
      base: metricRoundedBox(w, 0.2, d, 0.03),
      seat: metricRoundedBox(seatW - 0.012, 0.15, d - backD - 0.03, 0.05),
      back: metricRoundedBox(seatW - 0.02, 0.4, 0.16, 0.06),
      backFrame: metricRoundedBox(w, h - legH - 0.2, backD, 0.04),
      arm: metricRoundedBox(arm, 0.6 - legH, d, 0.05),
    }),
    [w, h, d, seatW, arm],
  );

  const legX = w / 2 - 0.07;
  const legZ = d / 2 - 0.07;
  return (
    <group>
      {[
        [-legX, -legZ],
        [legX, -legZ],
        [-legX, legZ],
        [legX, legZ],
      ].map(([x, z], i) => (
        <mesh key={i} geometry={g.leg} material={materials.walnut} position={[x, legH / 2, z]} castShadow />
      ))}
      <mesh geometry={g.base} material={fabric} position={[0, legH + 0.1, 0]} castShadow receiveShadow />
      <mesh geometry={g.backFrame} material={fabric} position={[0, legH + 0.2 + (h - legH - 0.2) / 2, -d / 2 + backD / 2]} castShadow receiveShadow />
      {[-1, 1].map((s) => (
        <mesh key={s} geometry={g.arm} material={fabric} position={[s * (w / 2 - arm / 2), legH + (0.6 - legH) / 2, 0]} castShadow receiveShadow />
      ))}
      {Array.from({ length: seats }, (_, i) => {
        const x = -w / 2 + arm + seatW * (i + 0.5);
        return (
          <group key={i}>
            <mesh geometry={g.seat} material={fabric} position={[x, legH + 0.2 + 0.075, backD / 2 + 0.01]} castShadow receiveShadow />
            <mesh geometry={g.back} material={fabric} position={[x, seatTop + 0.2, -d / 2 + backD + 0.06]} rotation={[-0.14, 0, 0]} castShadow receiveShadow />
          </group>
        );
      })}
    </group>
  );
}

/* ------------------------------ 테이블 ------------------------------ */

function CoffeeTable({ item }: ModelProps) {
  const { materials } = useSceneResources();
  const [w, h, d] = item.size;
  const top = 0.035;
  const g = useOwnedGeometries(
    () => ({
      top: metricRoundedBox(w, top, d, 0.012, 2),
      leg: metricBox(0.04, h - top, 0.04),
      shelf: metricBox(w - 0.12, 0.02, d - 0.12),
      bookA: metricRoundedBox(0.26, 0.035, 0.2, 0.004, 1),
      bookB: metricRoundedBox(0.22, 0.03, 0.17, 0.004, 1),
      bowl: metricLathe([
        [0.001, 0],
        [0.06, 0.002],
        [0.1, 0.03],
        [0.115, 0.07],
        [0.11, 0.072],
        [0.095, 0.035],
        [0.001, 0.01],
      ]),
    }),
    [w, h, d],
  );
  const lx = w / 2 - 0.05;
  const lz = d / 2 - 0.05;
  return (
    <group>
      <mesh geometry={g.top} material={materials.marble} position={[0, h - top / 2, 0]} castShadow receiveShadow />
      {[
        [-lx, -lz],
        [lx, -lz],
        [-lx, lz],
        [lx, lz],
      ].map(([x, z], i) => (
        <mesh key={i} geometry={g.leg} material={materials.walnut} position={[x, (h - top) / 2, z]} castShadow receiveShadow />
      ))}
      <mesh geometry={g.shelf} material={materials.walnut} position={[0, 0.09, 0]} castShadow receiveShadow />
      <mesh geometry={g.bookA} material={materials.leather} position={[-0.25, h + 0.0175, 0.02]} rotation={[0, 0.2, 0]} castShadow receiveShadow />
      <mesh geometry={g.bookB} material={materials.fabric} position={[-0.24, h + 0.035 + 0.015, 0.02]} rotation={[0, -0.1, 0]} castShadow receiveShadow />
      <mesh geometry={g.bowl} material={materials.ceramic} position={[0.25, h, -0.03]} castShadow receiveShadow />
    </group>
  );
}

function SideTable({ item }: ModelProps) {
  const { materials, tinted } = useSceneResources();
  const [w, h] = item.size;
  // 사무실 라운지처럼 상판 색을 바꾸는 경우 복제 재질을 사용(기존 거실 재질은 변경하지 않음)
  const topMaterial = item.variant?.color ? tinted("oakLight", item.variant.color) : materials.oakLight;
  const g = useOwnedGeometries(
    () => ({
      top: metricCylinder(w / 2, w / 2, 0.03, 32),
      pole: metricCylinder(0.022, 0.022, h - 0.045, 12),
      base: metricCylinder(0.16, 0.17, 0.015, 32),
    }),
    [w, h],
  );
  return (
    <group>
      <mesh geometry={g.top} material={topMaterial} position={[0, h - 0.015, 0]} castShadow receiveShadow />
      <mesh geometry={g.pole} material={materials.blackMetal} position={[0, 0.015 + (h - 0.045) / 2, 0]} castShadow />
      <mesh geometry={g.base} material={materials.blackMetal} position={[0, 0.0075, 0]} castShadow receiveShadow />
    </group>
  );
}

/* ------------------------------ TV·콘솔 ------------------------------ */

function TvConsole({ item }: ModelProps) {
  const { materials } = useSceneResources();
  const [w, h, d] = item.size;
  const legH = 0.1;
  const bodyH = h - legH;
  const g = useOwnedGeometries(
    () => ({
      body: metricRoundedBox(w, bodyH, d, 0.01, 2),
      leg: metricBox(0.03, legH, 0.03),
      groove: metricBox(0.005, bodyH - 0.05, 0.004),
      handle: metricBox(0.12, 0.012, 0.015),
    }),
    [w, h, d],
  );
  const doors = 3;
  return (
    <group>
      <mesh geometry={g.body} material={materials.walnut} position={[0, legH + bodyH / 2, 0]} castShadow receiveShadow />
      {[
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ].map(([sx, sz], i) => (
        <mesh key={i} geometry={g.leg} material={materials.blackMetal} position={[sx * (w / 2 - 0.06), legH / 2, sz * (d / 2 - 0.05)]} castShadow />
      ))}
      {Array.from({ length: doors - 1 }, (_, i) => (
        <mesh key={i} geometry={g.groove} material={materials.plasticDark} position={[-w / 2 + (w / doors) * (i + 1), legH + bodyH / 2, d / 2 + 0.001]} />
      ))}
      {Array.from({ length: doors }, (_, i) => (
        <mesh key={i} geometry={g.handle} material={materials.brass} position={[-w / 2 + (w / doors) * (i + 0.5), legH + bodyH - 0.06, d / 2 + 0.008]} castShadow />
      ))}
    </group>
  );
}

function Tv({ item }: ModelProps) {
  const { materials } = useSceneResources();
  const [w, h] = item.size;
  const panelH = h - 0.1;
  const g = useOwnedGeometries(
    () => ({
      base: metricRoundedBox(0.42, 0.016, 0.2, 0.006, 1),
      neck: metricBox(0.07, 0.1, 0.03),
      panel: metricRoundedBox(w, panelH, 0.035, 0.006, 1),
      screen: new THREE.PlaneGeometry(w - 0.024, panelH - 0.024),
    }),
    [w, h],
  );
  return (
    <group>
      <mesh geometry={g.base} material={materials.blackMetal} position={[0, 0.008, 0]} castShadow receiveShadow />
      <mesh geometry={g.neck} material={materials.blackMetal} position={[0, 0.06, -0.02]} castShadow />
      <mesh geometry={g.panel} material={materials.plasticDark} position={[0, 0.1 + panelH / 2, 0]} castShadow receiveShadow />
      <mesh geometry={g.screen} material={materials.screen} position={[0, 0.1 + panelH / 2, 0.0181]} />
    </group>
  );
}

/* ------------------------------ 책장(책은 인스턴싱) ------------------------------ */

function Bookshelf({ item }: ModelProps) {
  const { materials, geometries } = useSceneResources();
  const [w, h, d] = item.size;
  const shelves = 5;
  const board = 0.025;
  const g = useOwnedGeometries(
    () => ({
      side: metricBox(board, h, d),
      back: metricBox(w, h, 0.012),
      shelf: metricBox(w - board * 2, board, d - 0.012),
      vase: metricLathe([
        [0.001, 0],
        [0.05, 0.002],
        [0.065, 0.06],
        [0.04, 0.17],
        [0.03, 0.2],
        [0.035, 0.21],
      ]),
    }),
    [w, h, d],
  );

  const shelfYs = useMemo(() => Array.from({ length: shelves + 1 }, (_, i) => board / 2 + 0.04 + (i * (h - board - 0.06)) / shelves), [h]);

  const books = useMemo(() => {
    const rand = rng(item.variant?.seed ?? 42);
    const palette = ["#7b3b2e", "#2f4858", "#c8b38a", "#5a6b4f", "#8c6e54", "#3d3d3f", "#b0533c", "#d8d0c0", "#45566e"].map((c) => new THREE.Color(c));
    const list: { matrix: THREE.Matrix4; color: THREE.Color }[] = [];
    const inner = w - board * 2;
    for (let s = 0; s < shelves; s++) {
      const y = shelfYs[s] + board / 2;
      const space = shelfYs[s + 1] - shelfYs[s] - board;
      let x = -inner / 2 + 0.02;
      const end = inner / 2 - 0.02;
      const gapAt = -inner / 2 + inner * (0.25 + rand() * 0.5);
      while (x < end) {
        if (Math.abs(x - gapAt) < 0.12 && s % 2 === 1) {
          x += 0.26; // 화병 자리
          continue;
        }
        const bw = 0.022 + rand() * 0.03;
        const bh = Math.min(space - 0.02, 0.18 + rand() * 0.12);
        const bd = 0.15 + rand() * 0.07;
        if (x + bw > end) break;
        const lean = rand() < 0.06 ? 0.18 : 0;
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3(x + bw / 2, y + bh / 2, -d / 2 + 0.012 + bd / 2 + 0.01),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -lean)),
          new THREE.Vector3(bw, bh, bd),
        );
        list.push({ matrix: m, color: palette[Math.floor(rand() * palette.length)] });
        x += bw + (lean ? 0.03 : 0.002);
      }
    }
    return list;
  }, [w, d, shelfYs, item.variant?.seed]);

  const instRef = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = instRef.current;
    if (!mesh) return;
    books.forEach((b, i) => {
      mesh.setMatrixAt(i, b.matrix);
      mesh.setColorAt(i, b.color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [books, geometries.book, materials.books]); // 리소스 교체(조명 갱신)로 인스턴스가 다시 생기면 다시 배치

  return (
    <group>
      {[-1, 1].map((s) => (
        <mesh key={s} geometry={g.side} material={materials.oakLight} position={[s * (w / 2 - board / 2), h / 2, 0]} castShadow receiveShadow />
      ))}
      <mesh geometry={g.back} material={materials.oakLight} position={[0, h / 2, -d / 2 + 0.006]} castShadow receiveShadow />
      {shelfYs.map((y, i) => (
        <mesh key={i} geometry={g.shelf} material={materials.oakLight} position={[0, y, 0.006]} castShadow receiveShadow />
      ))}
      <instancedMesh
        ref={instRef}
        args={[geometries.book, materials.books, books.length]}
        castShadow
        receiveShadow
        // 인스턴스 수가 바뀌면 다시 생성
        key={books.length}
      />
      {[1, 3].map((s) => (
        <mesh key={s} geometry={g.vase} material={materials.ceramic} position={[0.3 - s * 0.12, shelfYs[s] + board / 2, 0]} castShadow receiveShadow />
      ))}
    </group>
  );
}

/* ------------------------------ 조명기구 ------------------------------ */

function FloorLamp({ item }: ModelProps) {
  const { materials } = useSceneResources();
  const [, h] = item.size;
  const shadeH = 0.3;
  const g = useOwnedGeometries(
    () => ({
      base: metricCylinder(0.14, 0.15, 0.02, 32),
      pole: metricCylinder(0.011, 0.011, h - shadeH - 0.02, 10),
      shade: metricLathe(
        [
          [0.2, 0],
          [0.14, shadeH],
        ],
        40,
      ),
      bulb: metricSphere(0.04),
    }),
    [h],
  );
  return (
    <group>
      <mesh geometry={g.base} material={materials.blackMetal} position={[0, 0.01, 0]} castShadow receiveShadow />
      <mesh geometry={g.pole} material={materials.blackMetal} position={[0, 0.02 + (h - shadeH - 0.02) / 2, 0]} castShadow />
      <mesh geometry={g.shade} material={materials.lampShade} position={[0, h - shadeH, 0]} />
      <mesh geometry={g.bulb} material={materials.bulb} position={[0, h - shadeH + 0.12, 0]} />
    </group>
  );
}

function PendantLamp({ item }: ModelProps) {
  const { materials } = useSceneResources();
  const shadeH = 0.22;
  const roomHeight = useSceneConfig().room.height;
  const cordLen = Math.max(0.05, roomHeight - item.position[1] - shadeH);
  const g = useOwnedGeometries(
    () => ({
      shade: metricLathe(
        [
          [0.24, 0],
          [0.235, 0.04],
          [0.21, 0.1],
          [0.16, 0.16],
          [0.08, 0.205],
          [0.015, shadeH],
        ],
        48,
      ),
      cord: metricCylinder(0.004, 0.004, cordLen, 6),
      canopy: metricCylinder(0.06, 0.06, 0.03, 24),
      bulb: metricSphere(0.05),
    }),
    [cordLen],
  );
  return (
    <group>
      <mesh geometry={g.shade} material={materials.brass} castShadow />
      <mesh geometry={g.bulb} material={materials.bulb} position={[0, 0.07, 0]} />
      <mesh geometry={g.cord} material={materials.blackMetal} position={[0, shadeH + cordLen / 2, 0]} />
      <mesh geometry={g.canopy} material={materials.brass} position={[0, shadeH + cordLen - 0.015, 0]} />
    </group>
  );
}

/* ------------------------------ 화분(잎은 공유 지오메트리 + 인스턴싱) ------------------------------ */

function Plant({ item }: ModelProps) {
  const { materials, geometries } = useSceneResources();
  const [w, h] = item.size;
  const potH = h * 0.32;
  const potR = w * 0.38;
  const g = useOwnedGeometries(
    () => ({
      pot: metricLathe(
        [
          [0.001, 0],
          [potR * 0.75, 0],
          [potR, potH * 0.9],
          [potR * 1.04, potH],
          [potR * 0.92, potH],
          [potR * 0.9, potH * 0.92],
        ],
        32,
      ),
      soil: metricCylinder(potR * 0.9, potR * 0.9, 0.01, 24),
      stem: metricCylinder(0.006, 0.008, 1, 6),
    }),
    [potR, potH],
  );

  const { leaves, stems } = useMemo(() => {
    const rand = rng(item.variant?.seed ?? 1);
    const count = Math.round(14 + h * 26);
    const leafList: THREE.Matrix4[] = [];
    const stemList: THREE.Matrix4[] = [];
    const crown = h - potH;
    for (let i = 0; i < count; i++) {
      const angle = rand() * Math.PI * 2;
      const t = 0.25 + rand() * 0.75;
      const radial = (0.15 + rand() * 0.85) * w * 0.48 * Math.sin(t * Math.PI * 0.9 + 0.3);
      const tip = new THREE.Vector3(Math.cos(angle) * radial, potH + crown * t, Math.sin(angle) * radial);
      const base = new THREE.Vector3(0, potH, 0);
      // 줄기
      const dir = tip.clone().sub(base);
      const len = dir.length();
      stemList.push(
        new THREE.Matrix4().compose(
          base.clone().addScaledVector(dir, 0.5),
          new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize()),
          new THREE.Vector3(1, len, 1),
        ),
      );
      // 잎(납작한 타원체)
      const leafLen = (0.06 + rand() * 0.06) * Math.max(0.6, h);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.5 - rand() * 0.6, angle + Math.PI / 2, rand() * 0.4 - 0.2, "YXZ"));
      leafList.push(new THREE.Matrix4().compose(tip, q, new THREE.Vector3(leafLen * 0.42, 0.004, leafLen)));
    }
    return { leaves: leafList, stems: stemList };
  }, [h, w, potH, item.variant?.seed]);

  const leafRef = useRef<THREE.InstancedMesh>(null);
  const stemRef = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    leaves.forEach((m, i) => leafRef.current?.setMatrixAt(i, m));
    stems.forEach((m, i) => stemRef.current?.setMatrixAt(i, m));
    for (const r of [leafRef.current, stemRef.current]) {
      if (!r) continue;
      r.instanceMatrix.needsUpdate = true;
      r.computeBoundingSphere();
    }
  }, [leaves, stems, g.stem, geometries.leaf, materials.leaf]); // 리소스 교체로 인스턴스가 다시 생기면 다시 배치

  return (
    <group>
      <mesh geometry={g.pot} material={materials.ceramic} castShadow receiveShadow />
      <mesh geometry={g.soil} material={materials.soil} position={[0, potH * 0.92, 0]} receiveShadow />
      <instancedMesh key={`s${stems.length}`} ref={stemRef} args={[g.stem, materials.leaf, stems.length]} castShadow />
      <instancedMesh key={`l${leaves.length}`} ref={leafRef} args={[geometries.leaf, materials.leaf, leaves.length]} castShadow receiveShadow />
    </group>
  );
}

/* ------------------------------ 러그·액자·문 ------------------------------ */

function Rug({ item }: ModelProps) {
  const { materials } = useSceneResources();
  const [w, h, d] = item.size;
  // 러그 문양은 전체를 한 장으로 사용하므로 0..1 UV 그대로 사용
  const g = useOwnedGeometries(() => ({ rug: new THREE.BoxGeometry(w, h, d) }), [w, h, d]);
  return <mesh geometry={g.rug} material={materials.rug} position={[0, h / 2, 0]} receiveShadow />;
}

function WallArt({ item }: ModelProps) {
  const { materials, artworks } = useSceneResources();
  const [w, h, d] = item.size;
  const bar = 0.028;
  const g = useOwnedGeometries(
    () => ({
      v: metricBox(bar, h, d),
      hz: metricBox(w - bar * 2, bar, d),
      mat: new THREE.PlaneGeometry(w - bar * 2, h - bar * 2),
      art: new THREE.PlaneGeometry(w - 0.16, h - 0.16),
    }),
    [w, h, d],
  );
  const artMaterial = useMemo(() => {
    const m = new THREE.MeshStandardNodeMaterial({ map: artworks[item.id] ?? null, roughness: 0.85 });
    return m;
  }, [artworks, item.id]);
  useEffect(() => () => artMaterial.dispose(), [artMaterial]);

  return (
    <group position={[0, h / 2, 0]}>
      {[-1, 1].map((s) => (
        <mesh key={`v${s}`} geometry={g.v} material={materials.walnut} position={[s * (w / 2 - bar / 2), 0, d / 2]} castShadow receiveShadow />
      ))}
      {[-1, 1].map((s) => (
        <mesh key={`h${s}`} geometry={g.hz} material={materials.walnut} position={[0, s * (h / 2 - bar / 2), d / 2]} castShadow receiveShadow />
      ))}
      <mesh geometry={g.mat} material={materials.canvasWhite} position={[0, 0, 0.006]} receiveShadow />
      <mesh geometry={g.art} material={artMaterial} position={[0, 0, 0.008]} receiveShadow />
    </group>
  );
}

function Door({ item }: ModelProps) {
  const { materials } = useSceneResources();
  const [w, h] = item.size;
  const casing = 0.07;
  const g = useOwnedGeometries(
    () => ({
      slab: metricBox(w, h, 0.04),
      panel: metricRoundedBox(w - 0.24, h * 0.36, 0.012, 0.004, 1),
      casingV: metricBox(casing, h + casing, 0.02),
      casingH: metricBox(w + casing * 2, casing, 0.02),
      lever: metricRoundedBox(0.13, 0.018, 0.018, 0.008, 2),
      rose: metricCylinder(0.026, 0.026, 0.01, 20),
    }),
    [w, h],
  );
  return (
    <group>
      <mesh geometry={g.slab} material={materials.doorPaint} position={[0, h / 2, 0.02]} castShadow receiveShadow />
      {[0.27, 0.72].map((t) => (
        <mesh key={t} geometry={g.panel} material={materials.doorPaint} position={[0, h * t, 0.044]} castShadow receiveShadow />
      ))}
      {[-1, 1].map((s) => (
        <mesh key={s} geometry={g.casingV} material={materials.doorPaint} position={[s * (w / 2 + casing / 2), (h + casing) / 2, 0.01]} castShadow receiveShadow />
      ))}
      <mesh geometry={g.casingH} material={materials.doorPaint} position={[0, h + casing / 2, 0.01]} castShadow receiveShadow />
      <mesh geometry={g.rose} material={materials.brass} position={[w / 2 - 0.08, 1.0, 0.045]} rotation={[Math.PI / 2, 0, 0]} />
      <mesh geometry={g.lever} material={materials.brass} position={[w / 2 - 0.13, 1.0, 0.065]} castShadow />
    </group>
  );
}

/* ------------------------------ 미분류 가구 ------------------------------ */

/** 도면에서 종류를 분류하지 못한 가구: 크기만 반영한 무채색 박스(실제 형태로 보이지 않게) */
function UnknownBox({ item }: ModelProps) {
  const { tinted } = useSceneResources();
  const [w, h, d] = item.size;
  const g = useOwnedGeometries(() => ({ box: metricBox(w, h, d) }), [w, h, d]);
  return <mesh geometry={g.box} material={tinted("canvasWhite", item.variant?.color ?? "#c9c2b6")} position={[0, h / 2, 0]} castShadow receiveShadow />;
}

/* ------------------------------ 진입점 ------------------------------ */

const MODELS: Record<FurnitureKind, (props: ModelProps) => React.ReactNode> = {
  sofa: (p) => <Sofa {...p} seats={3} upholstery="fabric" />,
  armchair: (p) => <Sofa {...p} seats={1} upholstery="leather" />,
  coffeeTable: CoffeeTable,
  sideTable: SideTable,
  tvConsole: TvConsole,
  tv: Tv,
  bookshelf: Bookshelf,
  floorLamp: FloorLamp,
  pendantLamp: PendantLamp,
  plant: Plant,
  rug: Rug,
  wallArt: WallArt,
  door: Door,
  unknown: UnknownBox,
  // 사무실 가구(OfficeModels.tsx). 새 kind는 타입과 함께 여기에 등록해야 GLB 실패 시에도 대체 모델이 있다.
  ...OFFICE_MODELS,
};

export function ProceduralModel({ item }: ModelProps) {
  const Model = MODELS[item.kind];
  return <Model item={item} />;
}
