/**
 * 합성 평가 사례 생성(floor-plan-eval-samples.ts). 실행: npm run eval:samples
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildEvalSamples } from "./floor-plan-eval-samples";
import { ROOT } from "./floor-plan-files";

for (const [file, content] of await buildEvalSamples()) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  console.log(`생성: ${path.relative(ROOT, file)}`);
}
