/**
 * 수동 경로 기준선(단기 계획 S5) — AI 없이 편집기만으로 평가 사례의 정답 도면을 입력하는 과정을 브라우저에서 재현하고,
 * 필요한 최소 조작 수와 결과 정확도를 잰다. 사람의 실제 작업 시간은 이 도구로 잴 수 없다(조작 수만 기준선으로 쓴다).
 *
 * 준비: dev 서버(포트 3310) — npm run dev
 * 실행: npm run eval:manual -- [사례 id ...]   (기본: 합성 사례 전부, 결과 eval-results/manual-<시각>)
 *
 * 조작 모델(숙련 사용자의 최소 조작):
 *   보정: 이미지 열기 1 + 기준 구간·외곽 끌기 3 + 실제 길이 입력 2 + 적용 1 (AI 경로와 같으므로 따로 센다)
 *   벽: 도구 바꾸기 1(종류가 바뀔 때) + 이어 그리기 클릭(시작 1 + 벽마다 1) + 끝내기 Esc 1 + 기본값과 다른 두께 입력 1
 *   개구부: 도구 바꾸기 1(종류가 바뀔 때) + 벽 위 클릭 1 + 다른 값 입력(중심 위치·폭·경첩·열림) 각 1
 *   천장 높이: 도면에 적혀 있으면 입력 1
 *   개구부 높이·문짝 재질처럼 평면도에 없는 값은 입력하지 않는다(채점 대상 아님). 가구·기둥은 편집기에서 추가할 수 없다.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log, openChrome, setNumberFieldExpr, setSelectFieldExpr, sleep } from "./cdp-session.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVAL_DIR = path.join(ROOT, "examples/floor-plans/eval");
const BASE = process.env.BASE_URL ?? "http://localhost:3310";
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
const OUT = path.join(ROOT, "eval-results", `manual-${stamp}`);
const DOWNLOADS = path.join(OUT, "downloads");
mkdirSync(DOWNLOADS, { recursive: true });

const wanted = process.argv.slice(2);
const caseIds = readdirSync(EVAL_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((id) => !wanted.length || wanted.includes(id))
  .filter((id) => {
    const spec = JSON.parse(readFileSync(path.join(EVAL_DIR, id, "case.json"), "utf8"));
    return spec.synthetic && !spec.categories.includes("dimension-conflict"); // 충돌 사례는 정답 기하가 원룸과 같다
  });

const { scoreFloorPlan, formatScore } = await import("../src/lib/floorPlan/eval/score.ts");
const ED = "svg[aria-label='도면 구조 편집']";
const TOOL_LABEL = { solid: "벽", glass: "유리 벽", door: "문", window: "창", passage: "통로" };
const same = (a, b, eps = 0.0005) => Math.abs(a - b) <= eps;

const b = await openChrome({ port: 9361, profileDir: path.join(OUT, "profile"), shotDir: OUT });
const results = [];
try {
  await b.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOADS });
  await b.send("Emulation.setDeviceMetricsOverride", { width: 1680, height: 950, deviceScaleFactor: 1, mobile: false });

  for (const id of caseIds) {
    const dir = path.join(EVAL_DIR, id);
    const spec = JSON.parse(readFileSync(path.join(dir, "case.json"), "utf8"));
    const base = JSON.parse(readFileSync(path.join(dir, spec.base), "utf8"));
    const truth = JSON.parse(readFileSync(path.join(dir, spec.truth), "utf8"));
    const ops = { calibration: 0, walls: 0, wallFields: 0, openings: 0, openingFields: 0, ceiling: 0, tools: 0 };
    const t0 = Date.now();
    log("▶", id);

    /* 보정 */
    b.errors.length = 0;
    await b.send("Page.navigate", { url: `${BASE}/editor` });
    await b.waitFor(`!!document.querySelector(${JSON.stringify(ED)})`);
    await sleep(5000); // 하이드레이션 대기
    await b.setFiles("input[type=file][accept^='image']", [path.join(dir, spec.image)]);
    const cal = "svg[aria-label^='이미지 배율 보정']";
    await b.waitFor(`!!document.querySelector(${JSON.stringify(cal)})`);
    await sleep(500);
    const [r1, r2] = base.calibration.references;
    const m = base.calibration.pixelToPlan;
    const e0 = [-m[4] / m[0], -m[5] / m[3]];
    const e1 = [e0[0] + base.envelope.width / m[0], e0[1] + base.envelope.depth / m[3]];
    for (const [label, pts] of [
      ["② 기준 구간 1", [r1.a, r1.b]],
      ["③ 기준 구간 2(다른 방향)", [r2.a, r2.b]],
      ["④ 외곽(실내 마감면)", [e0, e1]],
    ]) {
      await b.clickButton(label);
      const [p, q] = await b.svgToScreen(cal, pts);
      await b.dragTo(p, q);
    }
    await b.evaluate(
      `(() => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; const ins = [...document.querySelectorAll("label")].filter((l) => l.textContent.includes("실제 길이")).map((l) => l.querySelector("input")); [${r1.length}, ${r2.length}].forEach((v, k) => { set.call(ins[k], String(v)); ins[k].dispatchEvent(new Event("input", { bubbles: true })); }); })()`,
    );
    await sleep(300);
    await b.clickButton("보정 적용 → 새 도면");
    await b.waitFor(`!!document.querySelector("${ED} image")`);
    ops.calibration = 1 + 3 + 2 + 1;

    const toScreen = async (pt) => (await b.svgToScreen(ED, [pt]))[0];
    const readField = (labelStart) =>
      b.evaluate(`(() => { const l = [...document.querySelectorAll("label")].find((x) => x.querySelector("span")?.textContent.trim().startsWith(${JSON.stringify(labelStart)}) && x.querySelector("input,select")); const i = l?.querySelector("input,select"); return i ? i.value : null; })()`);
    let tool = null;
    const useTool = async (kind) => {
      if (tool === kind) return;
      if (!(await b.clickButton(TOOL_LABEL[kind]))) throw new Error(`도구 버튼 없음: ${TOOL_LABEL[kind]}`);
      tool = kind;
      ops.tools++;
    };
    const setNumber = async (label, value, counter) => {
      if (!(await b.evaluate(setNumberFieldExpr(label, value)))) throw new Error(`입력란 없음: ${label}`);
      ops[counter]++;
    };

    /* 벽: 이어지는(앞 벽 끝 = 다음 벽 시작, 같은 종류) 벽은 한 번에 이어 그린다. */
    const chains = [];
    for (const w of truth.walls) {
      const last = chains.at(-1);
      const prev = last?.walls.at(-1);
      if (prev && prev.kind === w.kind && same(prev.end[0], w.start[0], 1e-6) && same(prev.end[1], w.start[1], 1e-6)) last.walls.push(w);
      else chains.push({ kind: w.kind, walls: [w] });
    }
    for (const chain of chains) {
      await useTool(chain.kind);
      await b.clickAt(...(await toScreen(chain.walls[0].start)));
      ops.walls++;
      for (const w of chain.walls) {
        await b.clickAt(...(await toScreen(w.end)));
        ops.walls++;
        // 새 벽이 선택되어 있다: 좌표·두께를 확인하고 다른 값만 고친다.
        const fields = [
          ["시작점 u", w.start[0]],
          ["시작점 v", w.start[1]],
          ["끝점 u", w.end[0]],
          ["끝점 v", w.end[1]],
          ["두께", w.thickness],
        ];
        for (const [label, want] of fields) {
          const got = Number(await readField(label));
          if (!same(got, want)) await setNumber(label, want, "wallFields");
        }
      }
      await b.key("Escape", "Escape", 27);
      ops.walls++;
    }

    /* 개구부: 소속 벽 위 중심을 클릭하고 다른 값만 고친다. */
    const { width: W, depth: D } = truth.envelope;
    const geom = {
      north: { start: [0, 0], end: [W, 0] },
      east: { start: [W, 0], end: [W, D] },
      south: { start: [W, D], end: [0, D] },
      west: { start: [0, D], end: [0, 0] },
      ...Object.fromEntries(truth.walls.map((w) => [w.id, w])),
    };
    for (const o of truth.openings) {
      const g = geom[o.wallId];
      const len = Math.hypot(g.end[0] - g.start[0], g.end[1] - g.start[1]);
      const dir = [(g.end[0] - g.start[0]) / len, (g.end[1] - g.start[1]) / len];
      const at = [g.start[0] + dir[0] * o.offset, g.start[1] + dir[1] * o.offset];
      await useTool(o.kind);
      const before = await b.count("[data-opening]");
      await b.clickAt(...(await toScreen(at)));
      ops.openings++;
      if ((await b.count("[data-opening]")) !== before + 1) throw new Error(`개구부 추가 실패: ${o.id}`);
      for (const [label, want] of [
        ["벽 시작점 → 중심", o.offset],
        ["폭", o.width],
      ]) {
        const got = Number(await readField(label));
        if (!same(got, want)) await setNumber(label, want, "openingFields");
      }
      if (o.kind === "door" && o.door) {
        for (const [label, want] of [
          ["경첩", o.door.hinge],
          ["열림", o.door.swing],
        ]) {
          if ((await readField(label)) !== want) {
            if (!(await b.evaluate(setSelectFieldExpr(label, want)))) throw new Error(`선택 상자 없음: ${label}`);
            await sleep(150);
            ops.openingFields++;
          }
        }
      }
    }

    /* 천장 높이 */
    if (!spec.ceilingHeightMissing) await setNumber("천장 높이", truth.ceilingHeight, "ceiling");
    const automationMs = Date.now() - t0;
    await b.shot(`${id}-manual`);

    /* 저장 → 채점 */
    const mtime = (f) => statSync(path.join(DOWNLOADS, f)).mtimeMs;
    const before = new Map(readdirSync(DOWNLOADS).map((f) => [f, mtime(f)]));
    await b.clickButton("JSON 저장");
    let saved = [];
    for (let i = 0; i < 20 && !saved.length; i++) {
      await sleep(300);
      saved = readdirSync(DOWNLOADS).filter((f) => f.endsWith(".json") && before.get(f) !== mtime(f));
    }
    if (!saved.length) throw new Error("저장 파일 없음");
    const doc = JSON.parse(readFileSync(path.join(DOWNLOADS, saved[0]), "utf8"));
    writeFileSync(path.join(OUT, `${id}.manual.json`), `${JSON.stringify(doc, null, 2)}\n`);
    // 수동 경로에는 "누락 표시"가 없으므로 높이 미표기 사례의 천장 높이는 채점에서 뺀다(사용자가 실측 높이를 따로 확인해야 함).
    const score = scoreFloorPlan({ truth, predicted: doc });
    const structure = ops.walls + ops.wallFields + ops.openings + ops.openingFields + ops.tools + ops.ceiling;
    const entry = {
      case: id,
      truth: { walls: truth.walls.length, openings: truth.openings.length, furniture: truth.furniture?.length ?? 0, columns: truth.columns?.length ?? 0 },
      ops: { ...ops, structure },
      automationMs,
      corrections: score.corrections,
      ceilingScored: !spec.ceilingHeightMissing,
      /** 입력 후에도 정답과 다른 항목 수(높이 미표기 사례는 천장 높이 제외) */
      remaining: score.corrections.total - (spec.ceilingHeightMissing ? score.corrections.ceiling : 0),
      pageErrors: [...b.errors],
    };
    results.push(entry);
    console.log(formatScore(score));
    log(`  조작: 보정 ${ops.calibration} + 구조 ${structure}(벽 클릭 ${ops.walls}·벽 값 ${ops.wallFields}·개구부 클릭 ${ops.openings}·개구부 값 ${ops.openingFields}·도구 ${ops.tools}·천장 ${ops.ceiling})`);
  }
} catch (e) {
  log("중단:", e.message);
  process.exitCode = 1;
} finally {
  b.close();
}

writeFileSync(path.join(OUT, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
log(`결과: ${path.relative(ROOT, path.join(OUT, "results.json"))}`);
for (const r of results) {
  log(
    r.case,
    `구조 조작 ${r.ops.structure}회(보정 ${r.ops.calibration}회 별도)`,
    `남은 수정 ${r.remaining}(벽 ${r.corrections.walls}·개구부 ${r.corrections.openings}·가구 ${r.corrections.furniture}·천장 ${r.ceilingScored ? r.corrections.ceiling : "제외"})`,
    `가구 ${r.truth.furniture}개·기둥 ${r.truth.columns}개는 수동 입력 불가`,
  );
}
