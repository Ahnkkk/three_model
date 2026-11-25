/**
 * FloorPlanDocument JSON Schema 파일과 사무실 예제를 Zod 스키마·officePlan.ts에서 다시 생성한다.
 * 실행: npm run schema:floor-plan
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, generatedFiles } from "./floor-plan-files";

for (const [file, text] of generatedFiles()) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
  console.log(`생성: ${path.relative(ROOT, file)}`);
}
