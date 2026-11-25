/**
 * 렌더러 기능 확인.
 * 모듈 최상위에서 window/navigator/GPU를 참조하지 않고, 함수 호출 시점(클라이언트)에서만 확인한다.
 */
export type BackendKind = "webgpu" | "webgl2";

export interface Capabilities {
  webgpu: boolean;
  webgl2: boolean;
  /** WebGPU 어댑터 정보(가능한 경우) */
  adapter?: string;
  /** ?backend=webgl 로 WebGL 2 대체 경로를 강제한 경우 */
  forcedWebGL: boolean;
  preferred: BackendKind | null;
}

type GPUAdapterLike = { info?: { vendor?: string; architecture?: string; description?: string } };
type NavigatorGPU = { gpu?: { requestAdapter: (opts?: unknown) => Promise<GPUAdapterLike | null> } };

async function detectWebGPU(): Promise<{ ok: boolean; adapter?: string }> {
  const gpu = (navigator as unknown as NavigatorGPU).gpu;
  if (!gpu) return { ok: false };
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return { ok: false };
    const info = adapter.info;
    const label = [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(" ");
    return { ok: true, adapter: label || undefined };
  } catch {
    return { ok: false };
  }
}

function detectWebGL2(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("webgl2");
    const ok = !!ctx;
    ctx?.getExtension("WEBGL_lose_context")?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

export async function detectCapabilities(): Promise<Capabilities> {
  const forcedWebGL = new URLSearchParams(window.location.search).get("backend") === "webgl";
  const gpu: { ok: boolean; adapter?: string } = forcedWebGL ? { ok: false } : await detectWebGPU();
  const webgl2 = detectWebGL2();
  const preferred: BackendKind | null = gpu.ok ? "webgpu" : webgl2 ? "webgl2" : null;
  return { webgpu: gpu.ok, webgl2, adapter: gpu.adapter, forcedWebGL, preferred };
}
