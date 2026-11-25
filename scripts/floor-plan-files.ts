/**
 * 스키마에서 생성하는 파일 목록. 생성(generate-floor-plan-files.ts)과 최신 여부 검사(verify-floor-plan.ts)가 함께 쓴다.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FLOOR_PLAN_SCHEMA_FILE, floorPlanJsonSchema } from "../src/lib/floorPlan/schema";
import { buildOfficeFloorPlanDocument } from "./floor-plan-office";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const EXAMPLES_DIR = path.join(ROOT, "examples", "floor-plans");

export const toJsonText = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** [저장 경로, 내용] */
export function generatedFiles(): [string, string][] {
  return [
    [path.join(ROOT, "schemas", FLOOR_PLAN_SCHEMA_FILE), toJsonText(floorPlanJsonSchema())],
    [path.join(EXAMPLES_DIR, "office.json"), toJsonText(buildOfficeFloorPlanDocument())],
  ];
}
