# 도면 인식 평가 사례

AI 초안 추출을 같은 기준으로 채점하는 평가 세트입니다(단기 계획 S5). 사례마다 폴더 하나를 둡니다.

| 파일 | 내용 |
| --- | --- |
| `case.json` | 사례 정보, 정답 치수, 천장 높이 표기 여부 |
| 이미지(`plan.png` 등) | 원본 도면 |
| `base.json` | AI 추출 전 문서: 이미지 보정과 평면도 영역만 적용한 상태 |
| `truth.json` | 정답 문서: `base.json`과 같은 보정 기준에서 벽·개구부·가구·천장 높이를 입력하고 확인한 문서 |
| `fake-extraction.json` | (선택) 키 없이 흐름을 확인하는 고정 응답 |

## 현재 사례

모두 합성 사례입니다. 정답 문서를 프로그램으로 그린 축척 도면이라 정답이 확실하지만, 실제 대상 도면을 대신하지는 않습니다. `npm run eval:samples`로 다시 만듭니다.

| 사례 | 분류 | 내용 |
| --- | --- | --- |
| `studio-clean` | 깨끗한 도면 | 원룸 5×4m, 100px/m, 천장 높이 `CH 2600` 표기 |
| `studio-conflict` | 치수 충돌 | 상단 연속 치수 3,200을 3,600으로 적음(치수 충돌·합계 불일치) |
| `studio-lowres` | 저품질 | 절반 크기로 줄이고 흐리게 한 JPEG(약 50px/m) |
| `office-noheight` | 깨끗한 도면·높이 미표기 | 사무실 18×8m, 가구 47개·기둥 3개, 천장 높이 표기 없음 |

## 실제 도면 사례 추가하기

1. `/editor`에서 도면 이미지를 열고 평면도 영역·기준 구간·외곽을 지정한 뒤 "보정 적용 → 새 도면"을 누릅니다. 이 상태를 "JSON 저장"으로 저장해 `base.json`으로 둡니다.
2. 같은 문서에서 벽·문·창·가구·천장 높이를 직접 입력하고 확인한 뒤 저장해 `truth.json`으로 둡니다. AI 초안을 쓰지 않고 입력하면 수동 경로 기준선(걸린 시간·수정 횟수)도 함께 잴 수 있습니다.
3. `case.json`을 씁니다. `dimensions`에는 도면에 적힌 치수마다 적힌 값(m)과 그 치수가 재는 구간의 양 끝(도면 m)을 넣습니다. 구간 끝점은 보통 외곽(0, 폭·깊이)이나 벽 중심선 좌표(`truth.json`의 벽 `start`·`end`)와 같고, 치수선 위의 점이어도 됩니다(재는 방향의 구간만 비교). 기하와 다르게 적힌 치수에는 `"conflict": true`를 붙입니다.

```json
{
  "id": "site-a-1f",
  "description": "A 현장 1층 계획 평면도(스캔본)",
  "categories": ["clean"],
  "synthetic": false,
  "image": "plan.jpg",
  "base": "base.json",
  "truth": "truth.json",
  "fakeExtraction": null,
  "ceilingHeightMissing": true,
  "dimensions": [{ "text": "12,000", "value": 12, "a": [0, -1], "b": [12, -1] }]
}
```

분류(`categories`): `clean`, `missing-height`, `dimension-conflict`, `unsupported`, `low-quality`

## 실행

```bash
npm run eval:floor-plan -- --fake            # 고정 응답으로 흐름 확인(비용 없음)
npm run eval:floor-plan                      # 실제 호출 예정 횟수만 표시
npm run eval:floor-plan -- --yes             # 실제 모델 호출(.env.local의 키, 비용 발생)
npm run eval:floor-plan -- --yes --provider claude --case studio-clean --repeat 3
npm run score:floor-plan -- truth.json saved.json --case case.json   # 저장한 문서 두 개 채점
npm run eval:manual                          # 수동 경로 기준선: 편집기로 정답을 입력하는 최소 조작 수(dev 서버 필요)
```

결과는 `eval-results/<시각>/`에 사례별 응답·초안·채점 JSON과 `summary.md` 표로 남습니다(커밋하지 않음). 채점 규칙과 허용 오차는 [score.ts](../../../src/lib/floorPlan/eval/score.ts)의 `SCORE_TOLERANCE`에 고정되어 있습니다.
