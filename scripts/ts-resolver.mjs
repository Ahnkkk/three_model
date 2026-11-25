// Node 내장 TypeScript 타입 제거로 src/*.ts를 직접 실행하기 위한 경로 해석 훅.
// - "@/..." 별칭 → src/...
// - 확장자 없는 상대 경로 → .ts / .tsx
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

export async function resolve(specifier, context, nextResolve) {
  let spec = specifier;
  if (spec.startsWith("@/")) spec = pathToFileURL(path.join(srcRoot, spec.slice(2))).href;
  const isPath = spec.startsWith(".") || spec.startsWith("file:");
  if (isPath && !path.extname(spec)) {
    const base = spec.startsWith("file:") ? fileURLToPath(spec) : path.resolve(path.dirname(fileURLToPath(context.parentURL)), spec);
    for (const ext of [".ts", ".tsx"]) {
      if (existsSync(base + ext)) return nextResolve(pathToFileURL(base + ext).href, context);
    }
  }
  return nextResolve(spec, context);
}
