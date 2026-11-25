/**
 * 로더·디코더 설정.
 *
 * - Draco: three 패키지의 디코더를 public/decoders/draco 로 복사해 사용(postinstall). 외부 CDN 미사용.
 * - Meshopt: drei useGLTF 기본 내장 디코더 사용.
 * - KTX2: 현재 미사용. 도입 시 KTX2Loader(transcoder 경로) + renderer 기능 확인(detectSupport)을 함께 검증한다.
 */
export const DECODER_PATHS = {
  draco: "/decoders/draco/",
} as const;

export const LOADER_OPTIONS = {
  meshopt: true,
} as const;
