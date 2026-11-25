"use client";

import { Html } from "@react-three/drei";
import { useViewerStore } from "@/store/viewerStore";
import { useResolvedScene } from "@/components/viewer/SceneConfigContext";

/**
 * 3D 설명 표식(H형 ①·②, 입구). 메시에 글자를 굽지 않고 HTML 오버레이로 표시한다.
 * 조감도 모드에서만 보이며, 렌더링 설정에서 끌 수 있다.
 * 화살표 끝이 기준점(position)에 오도록 배치한다.
 */
export default function OfficeAnnotations() {
  const scene = useResolvedScene();
  const enabled = useViewerStore((s) => s.annotations);
  if (!enabled || !scene.view.annotations) return null;

  return (
    <>
      {scene.annotations.map((a) => (
        <Html key={a.id} position={a.position} zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
          <div
            className="flex select-none flex-col items-center"
            style={{ transform: a.arrow === "up" ? "translate(-50%, 0)" : "translate(-50%, -100%)" }}
          >
            {a.arrow === "up" && <Arrow up />}
            <span className="whitespace-nowrap rounded-full border-2 border-white bg-[#14305c] px-3 py-1 text-sm font-bold text-white shadow-lg">
              {a.label}
            </span>
            {a.arrow !== "up" && <Arrow />}
          </div>
        </Html>
      ))}
    </>
  );
}

function Arrow({ up = false }: { up?: boolean }) {
  return (
    <svg width="18" height="34" viewBox="0 0 18 34" className={up ? "rotate-180" : ""} aria-hidden>
      <path d="M9 0 V24" stroke="#14305c" strokeWidth="4" />
      <path d="M1 20 L9 33 L17 20 Z" fill="#14305c" />
    </svg>
  );
}
