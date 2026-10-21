# SPEC — 근거 기반 자동 글 생성 파이프라인 (blog · blogs 공통)

작성: @pm · 2026-10-21
대상: `scripts/auto-publish-runner.mjs`, `scripts/lib/llm.mjs`, 신규 `scripts/lib/fact-pipeline.mjs`
(blog, blogs 각 저장소에 동일 사본. 각 저장소 안에서만 작업)

## 배경

- 자동 글은 `gemini-2.5-flash` 가 검색 없이(`thinkingBudget: 0`) 기억만으로 작성한다.
- 2026-10-19~21 수동 검수에서 매번 사실 오류가 나왔다.
  - blog: 이벤트 ID 의미 오류, 존재하지 않는 icacls 권한(`RXW`), 지어낸 명령 출력, 루트 허브 참고 링크.
  - blogs: 자격 기준 금액 오류, 폐지된 제도(취업성공패키지) 서술, 잘못된 기관(HRD-Net), 무관한 참고 URL.
- blog 프롬프트가 "실행 결과 출력 블록을 생생하게" 요구해 출력 날조를 유도한다.
- blog 링크 검사는 404 링크를 상위 경로나 도메인 루트로 바꿔 '활성'으로 센다. 무의미한 참고 링크가 남는다.
- blog `TECH_FACT_SHEET_2026` 가 낡았다. Ubuntu 26.04 LTS 출시와 Python 3.14 등이 빠져 있다.

## 확인된 제약 (2026-10-21 실측)

- Google 검색 그라운딩(`tools: [{google_search:{}}]`)은 이 키에서 `gemini-2.5-flash` 만 가능하다.
- 3.x 모델에서 그라운딩을 쓰면 429가 난다.
- `gemini-3.8-flash` 는 그라운딩 없이 일반 생성으로는 사용할 수 있다.
- 그라운딩 출처 URI 는 `vertexaisearch…/grounding-api-redirect/…` 형태다. `redirect:'manual'` 로 요청하면 302 Location 에 실제 URL 이 온다.

## 설계: 3단계 파이프라인

1. **리서치 (grounded, 2.5-flash, thinking 2048)**
   - 입력: 카테고리, 기존 글 목록(중복 금지), 사이트 성격.
   - 출력: 주제 1개와 검증된 사실 목록(브리프).
     - 각 사실은 수치·조건·명령·버전이 담긴 한 문장에 출처 기관과 기준일을 붙인다.
     - 출처가 확인되지 않는 내용은 넣지 않는다.
   - 그라운딩 출처 URL 을 실제 주소로 풀어 공식 도메인을 우선 정렬한다.
   - 접속 200 이 확인된 것만 '허용 참고 링크' 목록으로 만든다.
   - 허용 링크가 최소 개수보다 적으면 사이트별 안전 링크 목록으로 보충한다.
     - blogs: law.go.kr 법령, 기관 루트.
     - blog: 실제 제품 문서 섹션.
2. **집필 (3.8-flash → 2.5-flash 폴백, 그라운딩 없음)**
   - 브리프에 있는 사실만 수치로 쓴다.
   - 참고 자료는 허용 링크 목록에서만 고른다.
   - 명령 출력은 공식 문서에 형식이 있는 경우에만 쓰고, 값은 `<placeholder>` 로 둔다. 지어낸 출력은 금지한다.
3. **팩트체크 (grounded, 2.5-flash, thinking 4096)**
   - 초안의 모든 사실 주장(수치, 날짜, 자격, 명령·옵션, 이벤트 ID, 버전)을 검색으로 확인한다.
   - 출력:
     - 교정된 전체 마크다운.
     - `===FACTCHECK_REPORT===` 구분선 뒤에 JSON `{verdict, corrections[], removed[]}`.
   - 판정 규칙:
     - `verdict:"reject"` (주제 전제가 틀림) → 게이트 실패, 재시도.
     - 보고서 파싱 실패, 본문이 원본의 70% 미만으로 줄어듦, H2 수가 게이트 미만 → 실패 처리.
     - 호출 실패(쿼터 등) → 발행하지 않음(fail closed).
   - 보고서는 `data/factcheck/<날짜>-<slug>.json` 에 저장하고, 교정 건수를 로그에 남긴다.

그 다음은 기존 구조·분량·링크 게이트가 교정본을 대상으로 그대로 돈다.

## 세부 변경

- `llm.mjs` `callGemini`
  - 옵션 추가: `models`(체인 지정), `thinkingBudget`(기본 0 유지), `googleSearch`.
  - 반환에 `grounding`(chunks, queries) 을 추가하고 thought 파트는 제외한다.
  - 기존 호출부 동작은 그대로다.
- 신규 `lib/fact-pipeline.mjs`: `researchTopic`, `resolveSources`, `factCheckArticle`.
- blog 러너
  - 프롬프트에서 출력 날조 유도 문구와 루트 허브 예시를 제거한다.
  - 404 링크를 상위나 루트로 바꾸는 폴백을 제거한다. 죽은 링크는 링크를 풀고 'gone' 으로 센다.
  - `TECH_FACT_SHEET_2026` 를 갱신하고, 버전은 브리프를 우선한다.
- blogs 러너
  - 본문 상단에 `:::note[기준일]` 를 넣게 한다.
  - 폐지·통합된 제도 서술을 금지한다(브리프 기준).
  - 금액·자격은 브리프 사실만 사용한다.

## 수용 기준

- 단위 테스트(`npm test`) 통과.
- 데몬 없이 생성 함수를 직접 호출해 실제 글 1편을 생성한다(발행·커밋 없음, 파일은 검토 후 삭제).
  - 리서치 → 집필 → 팩트체크 로그와 보고서가 나온다.
  - 참고 링크가 모두 200 이고 루트 허브가 없다.
- 기존 발행 경로(D1, git)에는 코드 변경이 없다.

## QA 승인 (@qa, 2026-10-21)

### 점검 항목
- `node --check` (runner, llm.mjs, fact-pipeline.mjs, 테스트) 통과. `npm test` 전체 통과 (fact-pipeline 12건 포함, 실패 0).
- 시스템 프롬프트 템플릿을 스텁 리서치 값으로 렌더링: 주제·브리프·허용 링크·`:::note[기준일]`·`author: "포켓머니"`·`category` 가 정상 치환된다. 백틱 이스케이프도 깨지지 않는다.
- 오류 플래그와 재시도: 리서치 게이트·팩트체크 실패는 `qualityGate` 로 던진다. 플래그 없는 오류(쿼터·네트워크)도 `generateArticleWithFallback` 의 catch 에서 '생성 오류'로 재시도된다. 최종 실패에는 `exhausted` 가 붙어 D1 발행 단계로 가지 않는다. duplicate·truncated(부분 응답 덤프) 처리는 그대로 유지된다. 시도 사이 대기는 30초다.
- avoidTopics 전파: 리서치 주제는 `options.rejectedSlugs`(호출부 `avoidTopics` 원본)에 들어가므로 다음 시도의 리서치 프롬프트 '탈락 주제'로 전달된다. 게이트 탈락 slug, 중복 slug 도 같은 목록에 쌓인다.
- `SITE_FACT_POLICY.sourcePolicy` 정규식: go.kr, or.kr, re.kr, korea.kr, gov.kr, sbiz24.kr, applyhome.co.kr 호스트가 정상 매칭된다. `allowNeutral:false` 라서 그 밖의 호스트는 모두 제외되고, `blocked` 목록은 사실상 보조 역할만 한다.
- `enforceAllowedLinks`
  - `INTERNAL_REF_HOSTS`(pockemoney.com 등) 링크와 허용 목록 링크는 유지된다. 끝 슬래시 차이, 퍼센트 인코딩 차이도 같은 링크로 본다.
  - 이미지와 코드 블록 안 링크는 건드리지 않는다.
  - 존재하지 않는 `/blog/<slug>` 링크는 링크를 풀고 텍스트만 남긴다.
- 발행 경로(D1, git): `gitPublish`·`publishPreflight`·publish-post 관련 코드는 diff 에 없어 변경되지 않았다. 팩트체크 보고서는 `data/factcheck/` 에만 쓰고 .gitignore 처리되어 있다.
- 참고 링크 카운터: `kind 'error' → counted.errors` 매핑이 정상이다(e2ba0b4 수정 유지).

### 수정 (QA 직접, 소규모)
1. `tidyHeadings` 가 '## 2026 근로장려금 일정', '## 3 가지 함정' 의 앞 숫자를 소제목 번호로 보고 지웠다. 정규식을 구분 기호(`.` 또는 `)`)가 있는 번호와 `2.1` 형식에만 맞도록 좁혔다. 테스트를 추가했다.
2. `enforceAllowedLinks` 가 `(^|[^!])` 접두 캡처를 쓰는 바람에 붙어 있는 링크(`[a](..)[b](..)`)의 두 번째 링크를 검사하지 못했다. `(?<!!)` lookbehind 로 바꿨다. 테스트를 추가했다.
3. SLUG_HINT 를 정리하지 않고 frontmatter 예시에 넣고 있었다. 모델이 `<english-kebab-case>` 자리표시자나 따옴표·공백을 그대로 내면 프롬프트 예시가 깨진다. 이제 kebab-case 로 정리하고, 자리표시자이거나 비어 있으면 기본 예시를 쓴다.
4. `getPublishedSlugs` 가 앞 800자만 읽고 있었다. 기존 `readFrontmatterHead` 로 바꿔 긴 frontmatter 에서도 slug 를 놓치지 않는다. 현재 글은 모두 800자 안에 있어 실제 영향은 없었다.

### 잔여 위험
- `https://pockemoney.com/blog/<없는 slug>` 처럼 전체 URL 로 쓴 내부 링크는 slug 존재를 확인하지 않는다(상대 경로 `/blog/..` 만 확인).
- `<https://…>` 자동 링크, `[t](url "title")` 형식, 맨 URL 은 링크 해제 대상이 아니다. 이런 링크가 남으면 참고 링크 게이트가 허용 목록 밖 URL 을 셀 수 있다.
- 리서치 실패나 쿼터 오류에도 그 주제를 탈락 목록에 넣는다. 재시도마다 주제가 바뀌는 것은 의도된 동작이다.
- 시도 1회에 Gemini 를 최소 3번 호출하고(리서치, 집필, 팩트체크), 검색 0회 재호출과 backoff 8s·16s·32s 가 붙는다. 최악의 경우 세션 1회 소요 시간이 크게 늘어난다. 무료 키 그라운딩 한도(2.5-flash 전용)에 의존한다.
- `gemini-3.8-flash` 의 `thinkingBudget:1024` 와 그라운딩 제약은 2026-10-21 실측에만 근거한다. 모델 정책이 바뀌면 리서치·팩트체크가 fail-closed 로 발행을 막는다(안전한 방향).
- 팩트체크 품질 자체(교정 정확도)는 단위 테스트로 검증할 수 없다. 수용 기준의 실제 1편 생성 검증은 QA 범위(Gemini 호출 금지) 밖이라 수행하지 않았다.
- `data/` 의 일부 파일(state json, review-report 등)은 ignore 되지 않아 untracked 로 보인다(기존 상태). 커밋할 때 `git add -A` 를 쓰지 말 것.

승인: @qa 2026-10-21 (코드 감사·단위 테스트 기준. 실제 생성 1편 검증은 사용자 실행 시 확인 필요)

## QA 추가 승인 (@qa, 2026-10-21, 팩트체크 보고서 정리)

### 점검 항목
- 대상: `scripts/lib/fact-pipeline.mjs` 미커밋 변경 3건. (1) 규칙 3번에 '검토 중/개정안/발표안' 의 시행 여부 확인 지시 추가 (2) 출력 형식에 "corrections 에는 실제로 바꾼 항목만" 지시 추가 (3) 파싱 뒤 before·after 가 같은(trim 기준) corrections 항목 제거.
- `node --check` 통과.
- 경계 사례: corrections 가 배열이 아니면 손대지 않는다(로그 건수 0). null·문자열 등 객체가 아닌 항목은 판단할 수 없으므로 그대로 둔다. before·after 가 둘 다 없으면 '' 와 '' 로 비교되어 제거된다. before 만 있으면(삭제) 남는다. 숫자는 String 변환 뒤 비교한다.
- reject 판정은 `report.verdict` 만 보므로 필터의 영향을 받지 않는다. reject 메시지, 로그의 `교정 n건`, 반환되어 `data/factcheck/` 에 저장되는 보고서는 모두 필터 뒤 값을 쓴다.

### 수정 사항
- 필터를 `export function dropUnchangedCorrections(corrections)` 로 분리했다. 동작은 바뀌지 않았다. 배열이 아니면 입력을 그대로 돌려준다. 호출부는 `report.corrections = dropUnchangedCorrections(report.corrections);` 한 줄이다.
- `scripts/__tests__/fact-pipeline.test.mjs` 에 단위 테스트 6건을 추가했다(실제 변경 유지, trim 동일 제거, before·after 없음 제거, null·문자열 유지, 배열 아님, 숫자 비교). `npm test` 전체 통과.

### 잔여 위험
- verdict 가 `fixed` 인데 걸러 낸 뒤 corrections 가 0건일 수 있다(로그 "verdict=fixed | 교정 0건"). 교정본 본문은 그대로 쓰므로 발행에는 영향이 없다.
- reject 일 때 모델이 근거를 before==after 항목으로만 적으면 reject 메시지에서 그 근거가 빠진다. verdict 판정 자체는 바뀌지 않는다.
- 프롬프트 지시(시행 여부 확인)의 효과는 Gemini 호출 없이 검증할 수 없다. 다음 실제 발행분의 보고서에서 확인할 것.

승인: @qa 2026-10-21
