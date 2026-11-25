import * as THREE from "three/webgpu";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

/**
 * 가구용 지오메트리 유틸.
 * 모든 지오메트리의 uv를 "미터 단위 박스 투영"으로 다시 계산해, 재질 텍스처가 실제 크기 기준으로 반복되도록 한다.
 * (재질 repeat = 1 / metersPerTile)
 */
export function applyMetricBoxUV(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = geometry.getAttribute("position");
  let normal = geometry.getAttribute("normal");
  if (!normal) {
    geometry.computeVertexNormals();
    normal = geometry.getAttribute("normal");
  }
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(normal.getX(i));
    const ny = Math.abs(normal.getY(i));
    const nz = Math.abs(normal.getZ(i));
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (nx >= ny && nx >= nz) uv.set([z, y], i * 2);
    else if (ny >= nx && ny >= nz) uv.set([x, z], i * 2);
    else uv.set([x, y], i * 2);
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return geometry;
}

export function metricBox(w: number, h: number, d: number): THREE.BufferGeometry {
  return applyMetricBoxUV(new THREE.BoxGeometry(w, h, d));
}

export function metricRoundedBox(w: number, h: number, d: number, radius: number, segments = 3): THREE.BufferGeometry {
  const r = Math.min(radius, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001);
  return applyMetricBoxUV(new RoundedBoxGeometry(w, h, d, segments, r));
}

export function metricCylinder(rTop: number, rBottom: number, h: number, segments = 24): THREE.BufferGeometry {
  return applyMetricBoxUV(new THREE.CylinderGeometry(rTop, rBottom, h, segments));
}

/** 회전체(화분·전등갓 등). points는 (반지름, 높이) 목록 */
export function metricLathe(points: [number, number][], segments = 32): THREE.BufferGeometry {
  const geo = new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), segments);
  geo.computeVertexNormals();
  return applyMetricBoxUV(geo);
}

/**
 * 모서리가 둥근 직사각 판재(회의 테이블 상판 등). 바닥면이 y = 0, 윗면이 y = thickness.
 * width는 x, depth는 z 방향 크기다.
 */
export function metricRoundedSlab(width: number, depth: number, thickness: number, cornerRadius: number): THREE.BufferGeometry {
  const r = Math.min(cornerRadius, width / 2 - 0.001, depth / 2 - 0.001);
  const w = width / 2;
  const d = depth / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-w + r, -d);
  shape.lineTo(w - r, -d);
  shape.quadraticCurveTo(w, -d, w, -d + r);
  shape.lineTo(w, d - r);
  shape.quadraticCurveTo(w, d, w - r, d);
  shape.lineTo(-w + r, d);
  shape.quadraticCurveTo(-w, d, -w, d - r);
  shape.lineTo(-w, -d + r);
  shape.quadraticCurveTo(-w, -d, -w + r, -d);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 2, curveSegments: 10 });
  // 도형 평면(xy)을 바닥면(xz)으로 눕히고 두께 방향을 +y로
  geo.rotateX(Math.PI / 2);
  geo.translate(0, thickness, 0);
  return applyMetricBoxUV(geo);
}

export function metricSphere(r: number, wSeg = 16, hSeg = 12): THREE.BufferGeometry {
  return applyMetricBoxUV(new THREE.SphereGeometry(r, wSeg, hSeg));
}
