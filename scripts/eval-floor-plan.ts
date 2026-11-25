/**
 * 도면 인식 평가 실행기(단기 계획 S5). 평가 사례마다 AI 추출 → 기본 선택 적용 → 정답과 채점하고,
 * 처리 시간·토큰·추정 비용과 함께 결과를 저장한다. 서버 경계(route)를 거치지 않고 같은 처리 함수(runExtraction)를 직접 호출한다.
 *
 * 실행:
 *   npm run eval:floor-plan -- --fake                      키 없이 고정 응답으로 흐름 확인(비용 없음)
 *   npm run eval:floor-plan -- --yes                       실제 모델 호출(키가 있는 공급자 모두). 비용이 발생한다.
 * 옵션:
 *   --provider claude|openai   공급자(여러 번 지정 가능, 기본: 키가 있는 공급자 전부)
 *   --case <id>                사례(여러 번 지정 가능, 기본: examples/floor-plans/eval의 전부)
 *   --repeat <n>               같은 사례 반복 횟수(모델 결과 편차 확인, 기본 1)
 *   --out <dir>                결과 폴더(기본 eval-results/<시각>)
 * 키는 .env.local(없으면 .env)에서 읽는다. 결과 폴더는 커밋하지 않는다(.gitignore).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AI_PROVIDERS, type AiProviderId } from "../src/lib/floorPlan/ai/protocol";
import { formatScore } from "../src/lib/floorPlan/eval/score";
import { providerConfig, type ProviderCall } from "../src/server/floorPlanAi/config";
import { providerCall } from "../src/server/floorPlanAi/providers";
import { fakeCall, listCaseDirs, loadCase, runCase, type CaseRun } from "./floor-plan-eval";
import { ROOT } from "./floor-plan-files";

const args = process.argv.slice(2);
const many = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
const one = (name: string) => many(name)[0];
const flag = (name: string) => args.includes(name);

const fake = flag("--fake");
const repeat = Math.max(1, Number(one("--repeat") ?? 1) || 1);
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
const outDir = path.resolve(one("--out") ?? path.join(ROOT, "eval-results", `${stamp}${fake ? "-fake" : ""}`));

if (!fake) {
  for (const file of [".env.local", ".env"]) {
    const p = path.join(ROOT, file);
    if (existsSync(p)) {
      process.loadEnvFile(p);
      break;
    }
  }
}

const wanted = many("--provider");
for (const p of wanted) {
  if (!(AI_PROVIDERS as readonly string[]).includes(p)) {
    console.error(`알 수 없는 공급자: ${p} (claude 또는 openai)`);
    process.exit(2);
  }
}
const providers = ((wanted.length ? wanted : [...AI_PROVIDERS]) as AiProviderId[]).filter((p) => {
  if (fake || providerConfig(p).apiKey) return true;
  if (wanted.includes(p)) console.warn(`건너뜀: ${p} — API 키가 없습니다(.env.local 확인).`);
  return false;
});

const caseIds = many("--case");
const cases = listCaseDirs()
  .map(loadCase)
  .filter((c) => !caseIds.length || caseIds.includes(c.spec.id));
for (const id of caseIds) if (!cases.some((c) => c.spec.id === id)) console.warn(`없는 사례: ${id}`);

if (!providers.length || !cases.length) {
  console.error(`실행할 ${!providers.length ? "공급자(키 없음 — 키 없이 확인하려면 --fake)" : "사례"}가 없습니다.`);
  process.exit(1);
}
const runs = providers.length * cases.length * repeat;
if (!fake && !flag("--yes")) {
  console.log(
    `실제 모델 호출 ${runs}회(공급자 ${providers.map((p) => `${p}:${providerConfig(p).model}`).join(", ")} × 사례 ${cases.length} × 반복 ${repeat}). 비용이 발생합니다.\n진행하려면 --yes를 붙여 다시 실행하세요. 키 없이 흐름만 확인하려면 --fake.`,
  );
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
console.log(`결과 폴더: ${path.relative(ROOT, outDir) || outDir}\n`);

const results: (CaseRun & { run: number })[] = [];
for (const c of cases) {
  for (const provider of providers) {
    let call: ProviderCall;
    if (fake) {
      if (!c.spec.fakeExtraction) {
        console.warn(`건너뜀: ${c.spec.id} — 고정 응답(fakeExtraction)이 없습니다.`);
        continue;
      }
      call = fakeCall(path.join(c.dir, c.spec.fakeExtraction));
    } else {
      call = providerCall(providerConfig(provider));
    }
    for (let n = 1; n <= repeat; n++) {
      const name = `${c.spec.id}.${provider}${repeat > 1 ? `.${n}` : ""}`;
      process.stdout.write(`${name} … `);
      const r = await runCase(c, provider, call);
      results.push({ ...r, run: n });
      writeFileSync(path.join(outDir, `${name}.response.json`), `${JSON.stringify(r.response, null, 2)}\n`);
      if (r.draft) writeFileSync(path.join(outDir, `${name}.draft.json`), `${JSON.stringify(r.draft, null, 2)}\n`);
      if (r.score) writeFileSync(path.join(outDir, `${name}.score.json`), `${JSON.stringify(r.score, null, 2)}\n`);
      if (r.response.ok) {
        console.log(`완료 ${(r.wallMs / 1000).toFixed(1)}s`);
        console.log(formatScore(r.score!));
      } else {
        console.log(`실패 ${r.response.code}: ${r.response.message}`);
      }
    }
  }
}

/* 요약 */
const pct = (v: number | null | undefined) => (v === null || v === undefined ? "-" : `${Math.round(v * 100)}%`);
const pair = (a: number | null | undefined, b: number | null | undefined) => `${pct(a)} / ${pct(b)}`;
const header = [
  "사례",
  "공급자",
  "모델",
  "결과",
  "시간(s)",
  "토큰(입력/출력)",
  "추정 비용($)",
  "벽 재현/정밀",
  "벽 길이 재현/정밀",
  "개구부 재현/정밀",
  "가구 재현/정밀",
  "치수 연결/정확",
  "충돌 감지",
  "천장",
  "추정 수정 수",
];
const rows = results.map((r) => {
  const res = r.response;
  const s = r.score;
  const usage = res.usage;
  return [
    r.caseId + (repeat > 1 ? ` #${r.run}` : ""),
    r.provider,
    res.ok ? res.model : "-",
    res.ok ? "성공" : `실패(${res.code})`,
    (r.wallMs / 1000).toFixed(1),
    usage ? `${usage.inputTokens} / ${usage.outputTokens}` : "-",
    usage?.estimatedCostUsd === null || usage?.estimatedCostUsd === undefined ? "-" : usage.estimatedCostUsd.toFixed(4),
    s ? pair(s.walls.recall, s.walls.precision) : "-",
    s ? pair(s.walls.lengthRecall, s.walls.lengthPrecision) : "-",
    s ? pair(s.openings.recall, s.openings.precision) : "-",
    s ? pair(s.furniture.recall, s.furniture.precision) : "-",
    s?.dimensions ? pair(s.dimensions.linkAccuracy, s.dimensions.exactAccuracy) : "-",
    s?.dimensions ? `${s.dimensions.conflictsDetected}/${s.dimensions.conflictsExpected}` : "-",
    s ? (s.ceiling.ok ? "맞음" : "다름") : "-",
    s ? String(s.corrections.total) : "-",
  ];
});
const table = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
const totalCost = results.reduce((sum, r) => sum + (r.response.usage?.estimatedCostUsd ?? 0), 0);
const summary = [
  `# 도면 인식 평가 결과 (${new Date().toISOString()})`,
  "",
  fake ? "고정 응답(--fake)으로 실행했다. 모델 성능이 아니라 실행·채점 흐름 확인용이다." : `실제 모델 호출. 추정 비용 합계 $${totalCost.toFixed(4)}(공개 단가 기준 추정치, 청구 금액 아님).`,
  "",
  table,
  "",
  "재현율 = 일치 / 정답, 정밀도 = 일치 / 결과. 치수 연결 = 구간을 맞게 연결한 정답 치수 비율, 정확 = 구간과 값이 모두 맞은 비율.",
  "추정 수정 수 = 누락 + 오검출 + 허용 오차를 넘는 일치 항목 + 천장 높이(실제 수동 수정 횟수와 다를 수 있음). 허용 오차는 score.ts의 SCORE_TOLERANCE.",
  "",
].join("\n");
writeFileSync(path.join(outDir, "summary.md"), summary);
writeFileSync(
  path.join(outDir, "summary.json"),
  `${JSON.stringify(
    results.map((r) => ({
      case: r.caseId,
      provider: r.provider,
      run: r.run,
      ok: r.response.ok,
      code: r.response.ok ? undefined : r.response.code,
      model: r.response.ok ? r.response.model : undefined,
      attempts: r.response.attempts,
      wallMs: r.wallMs,
      usage: r.response.usage,
      corrections: r.score?.corrections,
    })),
    null,
    2,
  )}\n`,
);
console.log(`\n${table}\n\n요약 저장: ${path.relative(ROOT, path.join(outDir, "summary.md"))}`);
