/**
 * 헤드리스 Chrome을 CDP로 직접 구동하는 공용 도구(browser-matrix.mjs·manual-baseline.mjs).
 * 모든 CDP 명령에 시간 제한을 두어 응답이 없으면 실패로 끝낸다.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/** Chrome을 띄우고 첫 페이지에 연결한다. */
export async function openChrome({ port, profileDir, chromePath = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", shotDir }) {
  const chrome = spawn(chromePath, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, "--window-size=1680,950", "--no-first-run", "about:blank"]);
  let targets;
  for (let i = 0; i < 60; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      if (targets.some((t) => t.type === "page")) break;
    } catch {}
    await sleep(250);
  }
  const page = targets?.find((t) => t.type === "page");
  if (!page) {
    chrome.kill();
    throw new Error("Chrome에 연결하지 못했습니다(CHROME_PATH 확인).");
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 500));
  };
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
  /** clip은 문서 좌표(스크롤 포함) */
  const shot = async (name, clip) => {
    const { data } = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    const buf = Buffer.from(data, "base64");
    if (name && shotDir) writeFileSync(path.join(shotDir, `${name}.png`), buf);
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
  /** SVG 사용자 좌표 → 화면 좌표 */
  const svgToScreen = (svgSel, pts) =>
    evaluate(`(() => { const s = document.querySelector(${JSON.stringify(svgSel)}); const m = s.getScreenCTM(); return ${JSON.stringify(pts)}.map(([x, y]) => { const p = new DOMPoint(x, y).matrixTransform(m); return [p.x, p.y]; }); })()`);
  const setFiles = async (selector, files) => {
    const { root } = await send("DOM.getDocument", { depth: -1, pierce: true });
    const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`요소 없음: ${selector}`);
    await send("DOM.setFileInputFiles", { nodeId, files });
  };
  await send("Page.enable");
  await send("Runtime.enable");
  const close = () => {
    try {
      ws.close();
    } catch {}
    chrome.kill();
  };
  return { send, evaluate, waitFor, shot, mouse, clickAt, dragTo, key, clickButton, count, center, svgToScreen, setFiles, errors, close };
}

/**
 * 편집기: 숫자 입력란(라벨 시작 문자열)에 값을 넣고 포커스를 옮겨 반영한다.
 * 입력란은 포커스가 빠질 때 React 상태의 글자를 반영하므로, 입력 후 다시 그려질 때까지 기다렸다가 포커스를 뺀다.
 */
export const setNumberFieldExpr = (labelStart, value) =>
  `(async () => { const l = [...document.querySelectorAll("label")].find((x) => x.querySelector("span")?.textContent.trim().startsWith(${JSON.stringify(labelStart)}) && x.querySelector("input[type=number]")); const i = l?.querySelector("input"); if (!i || i.disabled) return false; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; i.focus(); set.call(i, ${JSON.stringify(String(value))}); i.dispatchEvent(new Event("input", { bubbles: true })); await new Promise((r) => setTimeout(r, 120)); i.blur(); await new Promise((r) => setTimeout(r, 120)); return true; })()`;

/** 편집기: 선택 상자(라벨 문자열)의 값을 바꾼다 */
export const setSelectFieldExpr = (label, value) =>
  `(() => { const l = [...document.querySelectorAll("label")].find((x) => x.querySelector("span")?.textContent.trim() === ${JSON.stringify(label)} && x.querySelector("select")); const s = l?.querySelector("select"); if (!s) return false; const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`;
