/**
 * 브라우저 검증 매트릭스(단기 계획 S5) — 헤드리스 Chrome을 CDP로 직접 구동한다.
 *
 * 준비: 고정 응답을 켠 dev 서버(포트 3310)
 *   FLOOR_PLAN_AI_FAKE_FILE=examples/floor-plans/eval/studio-clean/fake-extraction.json npm run dev
 * 실행: npm run verify:browser -- [결과 폴더]   (기본 eval-results/browser-<시각>)
 *   환경 변수 CHROME_PATH(기본: Windows Chrome 설치 경로), BASE_URL(기본 http://localhost:3310)
 *
 * 데스크톱(1680×950): WebGPU(기본)·WebGL 2(?backend=webgl) 각각
 *   - 거실(/)·사무실(/office) 회귀: 3D 준비, 백엔드 표시, FPS, 페이지 오류, 스크린샷
 *   - 도면 문서(/plans): 예제 교체(원룸 → 사무실), JSON 파일 열기(평가 사례 정답 문서)
 *   - 편집기(/editor): 합성 도면 업로드 → 마우스로 기준 구간·외곽 지정 → 보정 → AI 초안(고정 응답) → 적용 → 3D
 *     → 벽 삭제·실행 취소 → JSON 저장 → 저장 파일을 정답과 채점(마우스 보정 오차가 그대로 드러난다)
 * 모바일(390×844, 터치): 네 화면의 가로 넘침, 3D 준비, 터치 끌기로 시점이 바뀌는지, 스크린샷
 */
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, "eval-results", `browser-${stamp}`));
const BASE = process.env.BASE_URL ?? "http://localhost:3310";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9351;
const CASE_DIR = path.join(ROOT, "examples/floor-plans/eval/studio-clean");
const DOWNLOADS = path.join(OUT, "downloads");
mkdirSync(DOWNLOADS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const results = [];

const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(OUT, "profile")}`, "--window-size=1680,950", "--no-first-run", "about:blank"]);

let ws;
let seq = 0;
const pending = new Map();
const errors = [];
const send = (method, params = {}, timeout = 30000) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method}: 응답 없음(${timeout / 1000}s)`));
    }, timeout);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
const waitFor = async (expr, timeout = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await evaluate(expr).catch(() => false)) return Date.now() - t0;
    await sleep(300);
  }
  throw new Error(`시간 초과: ${expr.slice(0, 120)}`);
};
const shot = async (name, clip) => {
  const { data } = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  const buf = Buffer.from(data, "base64");
  if (name) writeFileSync(path.join(OUT, `${name}.png`), buf);
  return buf;
};
const mouse = (type, x, y) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
const clickAt = async (x, y) => {
  await mouse("mouseMoved", x, y);
  await mouse("mousePressed", x, y);
  await mouse("mouseReleased", x, y);
  await sleep(150);
};
const dragTo = async (a, b) => {
  await mouse("mouseMoved", a[0], a[1]);
  await mouse("mousePressed", a[0], a[1]);
  for (let i = 1; i <= 8; i++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: a[0] + ((b[0] - a[0]) * i) / 8, y: a[1] + ((b[1] - a[1]) * i) / 8, button: "left", buttons: 1 });
  await mouse("mouseReleased", b[0], b[1]);
  await sleep(150);
};
const key = async (k, code, vk, mods = 0) => {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods, text: k.length === 1 && !mods ? k : undefined });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await sleep(150);
};
const clickButton = (text) => evaluate(`(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);
const count = (sel) => evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const center = (sel) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r ? [r.x + r.width / 2, r.y + r.height / 2] : null; })()`);
const svgToScreen = (svgSel, pts) =>
  evaluate(`(() => { const s = document.querySelector(${JSON.stringify(svgSel)}); const m = s.getScreenCTM(); return ${JSON.stringify(pts)}.map(([x, y]) => { const p = new DOMPoint(x, y).matrixTransform(m); return [p.x, p.y]; }); })()`);
const setFiles = async (selector, files) => {
  const { root } = await send("DOM.getDocument", { depth: -1, pierce: true });
  const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector });
  await send("DOM.setFileInputFiles", { nodeId, files });
};
const ready3d = `!document.body.innerText.includes("실내 공간 준비 중") && !!document.querySelector("canvas") && document.querySelector("canvas").getBoundingClientRect().width > 50`;
const backendBadge = `[...document.querySelectorAll("span")].map((e) => e.textContent.trim()).find((t) => t === "WebGPU" || t === "WebGL 2 대체") ?? null`;
// 사무실·도면 화면: "60 FPS" 한 덩어리, 거실(성능 패널): "FPS" 라벨 옆 값
const fpsText = `(() => { const els = [...document.querySelectorAll("span,div,dt,dd")]; const t = els.map((e) => e.textContent.trim()).find((x) => /^\\d+ FPS$/.test(x)); if (t) return Number(t.split(" ")[0]); const l = els.find((e) => e.textContent.trim() === "FPS" && e.nextElementSibling); const v = l ? Number(l.nextElementSibling.textContent.trim()) : NaN; return Number.isFinite(v) ? v : null; })()`;
const status3d = `[...document.querySelectorAll("span")].map((e) => e.textContent).find((t) => t.includes("조명 갱신 대기") || t === "최신" || t.includes("오류")) ?? null`;
const overflowX = `Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth`;

async function navigate(url) {
  errors.length = 0;
  await send("Page.navigate", { url: BASE + url });
  await sleep(1500);
  await waitFor(`document.readyState === "complete"`, 60000);
}

/** 화면 영역 두 장의 평균 픽셀 차이(0~255) */
async function imageDiff(a, b) {
  const [ra, rb] = await Promise.all([a, b].map((buf) => sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true })));
  if (ra.info.width !== rb.info.width || ra.info.height !== rb.info.height) return 255;
  let sum = 0;
  for (let i = 0; i < ra.data.length; i++) sum += Math.abs(ra.data[i] - rb.data[i]);
  return Math.round((sum / ra.data.length) * 100) / 100;
}

async function scenario(name, meta, fn) {
  const t0 = Date.now();
  const entry = { name, ...meta, ok: false, ms: 0, details: {}, errors: [] };
  log("▶", name, JSON.stringify(meta));
  try {
    await fn(entry.details);
    entry.ok = true;
  } catch (e) {
    entry.failure = e.message;
    log("  실패:", e.message);
  }
  entry.ms = Date.now() - t0;
  entry.errors = [...errors];
  if (entry.errors.length) log("  페이지 오류:", entry.errors.slice(0, 3));
  results.push(entry);
}

async function viewerCheck(d, url, shotName, settleMs = 5000) {
  await navigate(url);
  d.readyMs = await waitFor(ready3d, 180000);
  await sleep(settleMs);
  d.backend = await evaluate(backendBadge);
  d.fps = await evaluate(fpsText);
  await shot(shotName);
}

try {
  let targets;
  for (let i = 0; i < 60; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      if (targets.some((t) => t.type === "page")) break;
    } catch {}
    await sleep(250);
  }
  ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 500));
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOADS });

  const env = { browser: (await send("Browser.getVersion")).product };
  await send("Page.navigate", { url: BASE + "/plans" });
  await sleep(2000);
  env.webgpuAdapter = await evaluate(
    `(async () => { if (!navigator.gpu) return null; const a = await navigator.gpu.requestAdapter(); if (!a) return null; const i = a.info ?? {}; return [i.vendor, i.architecture, i.description].filter(Boolean).join(" / ") || "(정보 없음)"; })()`,
  );
  env.webglRenderer = await evaluate(
    `(() => { const gl = document.createElement("canvas").getContext("webgl2"); if (!gl) return null; const ext = gl.getExtension("WEBGL_debug_renderer_info"); return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })()`,
  );
  log("환경", JSON.stringify(env));

  /* ------------------------------ 데스크톱 ------------------------------ */
  await send("Emulation.setDeviceMetricsOverride", { width: 1680, height: 950, deviceScaleFactor: 1, mobile: false });
  for (const [backend, q] of [
    ["webgpu", ""],
    ["webgl2", "?backend=webgl"],
  ]) {
    const meta = { viewport: "desktop", requested: backend };
    await scenario("거실 회귀", meta, (d) => viewerCheck(d, `/${q}`, `desktop-${backend}-living`));
    await scenario("사무실 회귀", meta, (d) => viewerCheck(d, `/office${q}`, `desktop-${backend}-office`));

    await scenario("도면 문서: 예제 교체·JSON 열기", meta, async (d) => {
      await viewerCheck(d, `/plans${q}`, `desktop-${backend}-plans-studio`, 3000);
      const options = await evaluate(`[...document.querySelectorAll("select option")].map((o) => o.value)`);
      await evaluate(
        `(() => { const s = document.querySelector("select"); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(s, ${JSON.stringify(options[1])}); s.dispatchEvent(new Event("change", { bubbles: true })); })()`,
      );
      await sleep(1000);
      d.swapReadyMs = await waitFor(ready3d, 180000);
      await sleep(3000);
      d.swapBackend = await evaluate(backendBadge);
      await shot(`desktop-${backend}-plans-office`);
      await setFiles("input[type=file][accept^='application/json']", [path.join(ROOT, "examples/floor-plans/eval/studio-conflict/truth.json")]);
      await waitFor(`[...document.querySelectorAll("select option")].some((o) => o.selected && o.value === "studio-conflict-truth")`, 10000);
      d.fileReadyMs = await waitFor(ready3d, 180000);
      await sleep(3000);
      await shot(`desktop-${backend}-plans-file`);
      d.options = await evaluate(`[...document.querySelectorAll("select option")].map((o) => o.value)`);
    });

    await scenario("편집기: 업로드·보정·AI 초안·수정·저장", meta, async (d) => {
      await navigate(`/editor${q}`);
      await waitFor(`!!document.querySelector("svg[aria-label='도면 구조 편집']")`);
      await sleep(5000); // 하이드레이션 대기
      d.step = "이미지 업로드";
      await setFiles("input[type=file][accept^='image']", [path.join(CASE_DIR, "plan.png")]);
      const cal = "svg[aria-label^='이미지 배율 보정']";
      await waitFor(`!!document.querySelector(${JSON.stringify(cal)})`);
      await sleep(500);
      // 정답 보정값(base.json)과 같은 기준 구간·외곽을 마우스로 지정한다(평면도 영역은 지정하지 않음 = 이미지 전체).
      const base = JSON.parse(readFileSync(path.join(CASE_DIR, "base.json"), "utf8"));
      const [r1, r2] = base.calibration.references;
      const m = base.calibration.pixelToPlan;
      const env0 = [-m[4] / m[0], -m[5] / m[3]];
      const env1 = [env0[0] + base.envelope.width / m[0], env0[1] + base.envelope.depth / m[3]];
      for (const [label, pts] of [
        ["② 기준 구간 1", [r1.a, r1.b]],
        ["③ 기준 구간 2(다른 방향)", [r2.a, r2.b]],
        ["④ 외곽(실내 마감면)", [env0, env1]],
      ]) {
        if (!(await clickButton(label))) throw new Error(`버튼 없음: ${label}`);
        const [a, b] = await svgToScreen(cal, pts);
        await dragTo(a, b);
      }
      await evaluate(
        `(() => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; const ins = [...document.querySelectorAll("label")].filter((l) => l.textContent.includes("실제 길이")).map((l) => l.querySelector("input")); [${r1.length}, ${r2.length}].forEach((v, k) => { set.call(ins[k], String(v)); ins[k].dispatchEvent(new Event("input", { bubbles: true })); }); })()`,
      );
      await sleep(300);
      d.calibration = await evaluate(`[...document.querySelectorAll("span")].map((e) => e.textContent).find((t) => t.startsWith("배율")) ?? null`);
      await shot(`desktop-${backend}-editor-1-calibration`);
      d.step = "보정 적용";
      await clickButton("보정 적용 → 새 도면");
      await waitFor(`!!document.querySelector("svg[aria-label='도면 구조 편집'] image")`);

      d.step = "AI 초안";
      await clickButton("AI 초안");
      await waitFor(`!!document.querySelector("[role=dialog][aria-label='AI 초안 추출'] input[type=radio]:not([disabled])")`);
      await clickButton("이미지 보내고 추출");
      await waitFor(`[...document.querySelectorAll("button")].some((b) => b.textContent.startsWith("선택 항목 적용"))`, 60000);
      d.applyButton = await evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent.startsWith("선택 항목 적용")).textContent.trim()`);
      d.issuesShown = await evaluate(`document.querySelector("[role=dialog][aria-label='AI 초안 추출']").innerText.includes("천장")`);
      await shot(`desktop-${backend}-editor-2-proposal`);
      await evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent.startsWith("선택 항목 적용")).click()`);
      await waitFor(`document.querySelectorAll("[data-wall]").length === 3`, 10000);
      await clickButton("닫기");
      d.applied = { walls: await count("[data-wall]"), openings: await count("[data-opening]"), furniture: await count("[data-furniture]") };
      d.readyMs = await waitFor(ready3d, 180000);
      d.backend = await evaluate(backendBadge);
      try {
        await waitFor(`(${status3d}) === "최신"`, 90000);
      } catch {}
      d.status3d = await evaluate(status3d);
      await shot(`desktop-${backend}-editor-3-applied`);

      d.step = "수정";
      // 수정: 벽 하나 선택 → 삭제 → 실행 취소
      await key("v", "KeyV", 86);
      const wallId = await evaluate(`document.querySelector("[data-wall]").getAttribute("data-wall")`);
      await clickAt(...(await center(`[data-wall='${wallId}']`)));
      await key("Delete", "Delete", 46);
      d.afterDelete = await count("[data-wall]");
      await key("z", "KeyZ", 90, 2);
      d.afterUndo = await count("[data-wall]");

      d.step = "저장";
      // 같은 이름이면 덮어쓰므로 수정 시각으로 새 저장을 찾는다.
      const mtime = (f) => statSync(path.join(DOWNLOADS, f)).mtimeMs;
      const before = new Map(readdirSync(DOWNLOADS).map((f) => [f, mtime(f)]));
      await clickButton("JSON 저장");
      let saved = [];
      for (let i = 0; i < 20 && !saved.length; i++) {
        await sleep(300);
        saved = readdirSync(DOWNLOADS).filter((f) => f.endsWith(".json") && before.get(f) !== mtime(f));
      }
      if (!saved.length) throw new Error("저장 파일 없음");
      d.saved = saved[0];
      const { scoreFloorPlan } = await import("../src/lib/floorPlan/eval/score.ts");
      const truth = JSON.parse(readFileSync(path.join(CASE_DIR, "truth.json"), "utf8"));
      const spec = JSON.parse(readFileSync(path.join(CASE_DIR, "case.json"), "utf8"));
      const doc = JSON.parse(readFileSync(path.join(DOWNLOADS, saved[0]), "utf8"));
      const s = scoreFloorPlan({ truth, predicted: doc, ceilingHeightMissing: spec.ceilingHeightMissing });
      d.step = "완료";
      d.score = {
        envelope: `${doc.envelope.width} × ${doc.envelope.depth}`,
        frame: s.frame.ok,
        corrections: s.corrections,
        wallEndpointMax: s.walls.endpointError.max,
        openingCenterMax: s.openings.centerError.max,
        furnitureCenterMax: s.furniture.centerError.max,
      };
    });
  }

  /* ------------------------------ 모바일 ------------------------------ */
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  for (const [name, url] of [
    ["거실", "/"],
    ["사무실", "/office"],
    ["도면 문서", "/plans"],
    ["편집기", "/editor"],
  ]) {
    await scenario(`모바일: ${name}`, { viewport: "mobile-390x844", requested: "webgpu" }, async (d) => {
      await navigate(url);
      if (url === "/editor") {
        await waitFor(`!!document.querySelector("svg[aria-label='도면 구조 편집']")`);
        await sleep(5000);
        await evaluate(
          `(() => { const s = document.querySelector("select[aria-label='예제 열기']"); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(s, "0"); s.dispatchEvent(new Event("change", { bubbles: true })); })()`,
        );
        await waitFor(`document.querySelectorAll("[data-wall]").length > 0`, 20000);
        d.editorSvg = await evaluate(`(() => { const r = document.querySelector("svg[aria-label='도면 구조 편집']").getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })()`);
      }
      d.readyMs = await waitFor(ready3d, 180000);
      await sleep(4000);
      d.overflowX = await evaluate(overflowX);
      d.backend = await evaluate(backendBadge);
      d.canvas = await evaluate(`(() => { const r = document.querySelector("canvas").getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
      await shot(`mobile-${url === "/" ? "living" : url.slice(1)}`);
      // 캔버스를 덮는 UI 비율: 캔버스 위 격자점 중 다른 요소가 맨 위에 있는 비율(보이는 부분 기준)
      const c = d.canvas;
      if (c.y + c.h > 844) await evaluate(`document.querySelector("canvas").scrollIntoView({ block: "center" })`);
      await sleep(500);
      const probe = await evaluate(`(() => {
        const cv = document.querySelector("canvas"); const r = cv.getBoundingClientRect();
        const y0 = Math.max(0, r.y), y1 = Math.min(r.bottom, window.innerHeight);
        const free = []; let total = 0;
        for (let gy = 1; gy < 12; gy++) for (let gx = 1; gx < 8; gx++) {
          const x = r.x + (r.width * gx) / 8, y = y0 + ((y1 - y0) * gy) / 12; total++;
          if (document.elementFromPoint(x, y) === cv) free.push([x, y]);
        }
        // 스크린샷 clip은 문서 좌표이므로 스크롤 위치를 더한다(터치 좌표는 화면 좌표 그대로).
        return { rect: { x: r.x + scrollX, y: y0 + scrollY, width: r.width, height: y1 - y0 }, covered: Math.round((1 - free.length / total) * 100) / 100, free };
      })()`);
      d.coveredRatio = probe.covered;
      // 터치 끌기로 시점 변경: 캔버스가 노출된 점에서 가로로 끌고 화면 변화를 비교한다.
      const start = probe.free.find(([x, y]) => probe.free.some(([x2, y2]) => y2 === y && x2 - x >= 100)) ?? probe.free[0];
      if (!start) throw new Error("캔버스가 노출된 지점이 없음(UI가 3D 화면을 모두 덮음)");
      d.touchAt = start.map(Math.round);
      const before = await shot(null, probe.rect);
      await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: start[0], y: start[1] }] });
      for (let i = 1; i <= 10; i++) {
        await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start[0] + i * 10, y: start[1] }] });
        await sleep(30);
      }
      await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await sleep(1500);
      const after = await shot(null, probe.rect);
      d.touchDiff = await imageDiff(before, after);
      if (d.touchDiff < 1) throw new Error(`터치 끌기 후 화면 변화 없음(평균 차이 ${d.touchDiff})`);
      await shot(`mobile-${url === "/" ? "living" : url.slice(1)}-after-touch`);
    });
  }

  writeFileSync(path.join(OUT, "results.json"), `${JSON.stringify({ env, base: BASE, results }, null, 2)}\n`);
  log("\n환경:", JSON.stringify(env));
  for (const r of results) log(r.ok ? "PASS" : "FAIL", r.name, r.viewport, r.requested, `${(r.ms / 1000).toFixed(1)}s`, JSON.stringify(r.details), r.errors.length ? `오류 ${r.errors.length}` : "");
  log(`결과: ${path.join(OUT, "results.json")}`);
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
} catch (e) {
  log("중단:", e.message);
  process.exitCode = 1;
} finally {
  ws?.close();
  chrome.kill();
}
