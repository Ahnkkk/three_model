/**
 * 도면 두 개 채점(단기 계획 S5). 정답 문서와 결과 문서(AI 초안을 적용해 저장한 JSON, 또는 수동 입력 문서)를 비교한다.
 * 두 문서는 같은 이미지·같은 보정 기준에서 만든 것이어야 한다.
 *
 * 실행: npm run score:floor-plan -- <정답.json> <결과.json> [--case <case.json>] [--json <저장 경로>]
 *   --case  평가 사례 파일의 천장 높이 표기 여부를 쓴다(치수는 AI 제안에만 있으므로 이 도구는 채점하지 않는다).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { formatScore, scoreFloorPlan } from "../src/lib/floorPlan/eval/score";
import type { FloorPlanDocument } from "../src/lib/floorPlan/schema";
import { validateFloorPlan } from "../src/lib/floorPlan/validate";
import { EvalCaseSchema } from "./floor-plan-eval";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const casePath = option("--case");
const jsonPath = option("--json");
if (args.length !== 2) {
  console.error("사용법: npm run score:floor-plan -- <정답.json> <결과.json> [--case <case.json>] [--json <저장 경로>]");
  process.exit(2);
}

function read(file: string): FloorPlanDocument {
  const result = validateFloorPlan(JSON.parse(readFileSync(file, "utf8")));
  if (!result.document) {
    console.error(`${file}: 도면 문서 형식 오류\n${result.issues.map((i) => `  ${i.path} ${i.message}`).join("\n")}`);
    process.exit(1);
  }
  const errors = result.issues.filter((i) => i.severity === "error");
  if (errors.length) console.warn(`${file}: 문서 검증 오류 ${errors.length}개(채점은 계속) — ${errors.map((e) => e.code).join(", ")}`);
  return result.document;
}

const truth = read(args[0]);
const predicted = read(args[1]);
const spec = casePath ? EvalCaseSchema.parse(JSON.parse(readFileSync(casePath, "utf8"))) : null;
const score = scoreFloorPlan({ truth, predicted, ceilingHeightMissing: spec?.ceilingHeightMissing ?? false });
console.log(`정답 ${args[0]}\n결과 ${args[1]}\n${formatScore(score)}`);
if (jsonPath) {
  writeFileSync(jsonPath, `${JSON.stringify(score, null, 2)}\n`);
  console.log(`저장: ${jsonPath}`);
}
