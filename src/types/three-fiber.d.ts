import type * as THREE from "three/webgpu";
import type { ThreeToJSXElements } from "@react-three/fiber";

// three/webgpu 클래스(노드 재질 등)를 R3F JSX 요소로 사용하기 위한 타입 확장
declare module "@react-three/fiber" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}
