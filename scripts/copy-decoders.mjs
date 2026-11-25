// three 패키지에 포함된 Draco 디코더를 public/decoders/draco 로 복사한다(외부 CDN 의존 제거).
// npm install 후 자동 실행(postinstall). 버전이 three와 항상 일치한다.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules/three/examples/jsm/libs/draco/gltf");
const dest = join(root, "public/decoders/draco");

if (!existsSync(src)) {
  console.warn("[copy-decoders] three Draco 디코더를 찾지 못했습니다:", src);
  process.exit(0);
}
mkdirSync(dest, { recursive: true });
for (const file of ["draco_decoder.js", "draco_decoder.wasm", "draco_wasm_wrapper.js"]) {
  cpSync(join(src, file), join(dest, file));
}
console.log("[copy-decoders] Draco 디코더 복사 완료 →", dest);
