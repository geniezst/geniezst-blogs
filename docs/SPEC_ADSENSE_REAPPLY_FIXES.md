# 기술 사양서: pockemoney.com 애드센스 재신청 보완

* **작성자:** `@pm`
* **대상:** `/workspace/projects/blogs`
* **참조:** `docs/SPEC_ADSENSE_PREEMPTIVE_REMEDIATION.md`, `docs/POST_STYLE_GUIDE.md`, `docs/SPEC_PIPELINE_STABILITY_AND_IMAGE_PIPELINE.md`

---

## 콘텐츠·이미지

* **작성일:** 2026-10-19
* **상태:** 사용자 지시에 따라 구현 (콘텐츠 편집·팩트체크 담당)

### 1. 배경

2026-10-16 팩트체크·재작성으로 공개 글의 수치 오류는 대부분 정리됐지만, 재신청 전에 다음 문제가 남아 있다.

* 공개 글 24편 중 20편이 공백 제외 1,800자 미만(스타일 가이드 기준 미달)으로 "가치가 별로 없는 콘텐츠" 사유에 다시 걸릴 수 있다.
* 모든 글이 같은 뼈대(서두 1문단 → `:::note[확인 기준]` → 표 → `:::warning` → `## 참고한 자료`)로 되어 있어 템플릿 문체로 보인다.
* 일부 출처가 공식 기관이 아닌 언론·수험 매체(고시위크, 헤럴드경제)이거나 기관 홈페이지 첫 화면만 걸려 있다.
* 2026년 10월 발표 정책(버팀목·디딤돌 소득기준 완화 등)의 시행 여부가 "확인 필요" 상태로 남아 있다.
* 가이드 글에 대표 이미지(featured_image)·OG 이미지가 없다.

### 2. 작업 범위

#### 2.1 감사 (공개 글 전체, `status: "draft"`·`template.md` 제외)
점검 항목: 템플릿 문체(반복 H2·동일 서두/결론), 과장·확정적 투자 권유, 지어낸 사례·수치, 기준일 없는 금리·한도·세율, 오래되거나 틀린 제도 정보, 중복·유사 주제, 얇은 글.

#### 2.2 재작성 원칙
* 공식 출처(금융위원회, 국세청, 복지로, 정부24, 주택도시기금·마이홈포털, 고용노동부·고용24, 각 기관 공고)로 2026년 현재 기준을 확인한 수치만 쓴다.
* 글마다 "기준일"(확인 날짜)과 공식 출처 링크를 명시한다. 기관 첫 화면이 아니라 해당 제도 안내 페이지로 연결한다.
* 확인할 수 없는 수치는 삭제하거나 "공고 확인 필요"로 표기한다.
* 계산 예시는 공식 규칙을 그대로 적용한 산식만 쓰고, 가상의 인물·후기·경험담은 쓰지 않는다.
* 담백한 문체. 글마다 구성 순서를 주제에 맞게 달리하고, 같은 서두·맺음 문장을 반복하지 않는다.
* `slug`·`date` frontmatter 변경 금지, 제목에 `:` 금지.
* 고칠 수 없는 글은 `status: "draft"` 로 내리고 목록을 보고한다.

#### 2.3 이미지 (직접 제작)
* 핵심 글 10편 이상에 자격 요건 흐름도, 금리·한도 비교표, 신청 절차도 등 인포그래픽을 SVG로 직접 그리고 `sharp` 로 래스터 변환한다. 외부 이미지·스톡·AI 생성 이미지 사용 금지.
* 저장 위치: `public/assets/posts/<slug>/` (정적 자산, 배포 시 함께 서빙)
  * `cover.webp` — 1200×630, 대표 이미지(`featured_image`)
  * `og.jpg` — 1200×630, OG 이미지(`og_image`). `SEO.astro` 가 `.jpg` 확장자일 때만 `image/jpeg` 를 출력하므로 JPEG 로 만든다.
  * `*.webp` — 본문 인포그래픽, 원본 `*.svg` 함께 보관
* frontmatter: `featured_image: "/assets/posts/<slug>/cover.webp"`, `og_image`, `image_width: 1200`, `image_height: 630`
  * `publish-post.mjs` 는 `featured_image` 가 `/` 로 시작하는 사이트 경로면 R2 업로드를 건너뛰고 값을 그대로 D1 에 저장한다.
* 본문 삽입: `![구체적인 대체 텍스트](/assets/posts/<slug>/<name>.webp "기준일 포함 캡션")`
* 수치가 들어간 이미지는 본문 수치와 일치시키고 이미지 안에 기준일을 표기한다.
* 한글 렌더링: 컨테이너에 한글 폰트가 없으므로 변환 시 `FONTCONFIG_FILE` 로 `/workspace/scripts/nanumgothic.ttf` 를 읽기 전용으로 참조한다.

### 3. 검증 기준
* `npm run build` 성공, `npm test` 통과
* `publish-post.mjs` 가 `featured_image`·`og_image`·`image_width/height`·`status` 를 D1 에 반영하는지 코드로 확인(실행 금지)
* 변경 글 목록을 작업 scratchpad 의 `blogs_content/changed.txt` 에 저장

### 4. 금지
* `/workspace/projects/blogs` 밖 수정, `src/` 코드 수정, git commit/push, `publish-post.mjs` 실행, D1 원격 쓰기, 배포, 데몬·Playwright 실행
* 작업 시작(2026-10-19 12:53 KST) 이후 자동 발행 데몬이 추가한 글은 수정하지 않는다.

### 5. 배포 시 주의
* 본문·대표 이미지는 `public/assets/posts/` 정적 자산이므로, D1 에 글을 다시 발행하기 **전에** 사이트를 먼저 배포해야 이미지가 깨지지 않는다(본문 이미지는 `onerror` 로 숨겨지지만 대표 이미지 영역이 빈다).

### 6. 적용 결과 (2026-10-19)
* 공개 글 24편 전체 수정(재작성 15편, 사실 정정·보강 9편), draft 전환 0편. slug·date 변경 없음, 제목 콜론 없음.
* 사실 정정: 청년도약계좌 갈아타기(2차 모집에도 허용, 금융위 2026.9 보도자료), 2027 청년월세 확대(고시위크 기사의 "중위 80%·18~39세" → 정부 주거안정플랜 보도 기준 "중위 100%·18세 포함·차상위 48개월"), 버팀목·디딤돌 신혼 소득기준 "1억500만원/1억원"(공식 확인 불가 → 삭제, "부부 중 1인 일반기준 충족 시 허용" 방향만 표기), 비공식 출처(고시위크) 제거.
* 이미지: 24편 대표(cover.webp)·OG(og.jpg) 1200×630, 본문 인포그래픽 23편. 원본 SVG 동봉.
* 검증: `npm run build` 성공(`ASTRO_TELEMETRY_DISABLED=1` 필요 — 컨테이너에서 `~/.config` 쓰기 권한 없음), `npm test` 통과.
* QA 승인 서명: 완료 — 문서 끝 `## QA` 참조

---

## 플랫폼

* **작성일:** 2026-10-19
* **상태:** 사용자 지시에 따라 구현 (@frontend/@backend 담당, QA 승인 대기)

### 1. 라이브 점검 결과 (2026-10-19, curl)

| 항목 | 결과 | 판정 |
|---|---|---|
| `http://pockemoney.com/` | 301 → `https://pockemoney.com/` | 정상 |
| `https://www.pockemoney.com/about?x=1` | 301 → `https://pockemoney.com/about?x=1` (쿼리 보존) | 정상 |
| `http://www.pockemoney.com/about` | 301 → `https://www.…` → 301 → apex (2회). 첫 301은 Cloudflare 엣지("Always Use HTTPS")가 Worker 앞에서 응답 | 주의 (엣지 설정) |
| `https://blogs.geniezst.workers.dev/` | 200 (canonical 은 apex) | 수정 — 중복 호스트 |
| `/about/` | 200, canonical `https://pockemoney.com/about/` | 수정 — 중복 URL·canonical 불일치 |
| canonical 쿼리 제거 | `/about?utm=1` → canonical `/about` | 정상 |
| ads.txt / AdSense 스크립트 | 둘 다 `pub-9338927727391440` | 정상 |
| `google-adsense-account` 메타 | 없음 | 추가 |
| robots.txt | `sitemap.xml`, `sitemap-index.xml` 둘 다 등록, 두 파일이 같은 urlset | 수정 — 중복 |
| sitemap URL 35개 | 전부 200 | 정상 |
| `/terms` | 라이브 404, 푸터·사이트맵에 없음 | 수정 (페이지는 콘텐츠 담당이 `src/pages/terms.astro` 생성) |
| 404 | 없는 경로 404 하드 응답 | 정상 |
| 모바일 내비 | 햄버거+드로어 있음. `aria-expanded`/`aria-controls` 없음, 닫힌 상태에서도 링크 포커스 가능, Esc 미지원 | 보완 |
| 홈 h1 | 없음 (h2부터 시작) | 추가 |
| JSON-LD 날짜 | `"2026-10-18 09:43:47"` (D1 UTC 문자열, 시간대 없음) | 수정 — ISO 8601 `+09:00` |

### 2. 요구사항

1. **URL 정규화 (`src/middleware.ts`)**
   * 끝 `/` 가 붙은 경로(루트 제외)는 `/` 를 뗀 경로로 301, 쿼리스트링 보존.
   * www, http, `*.workers.dev` 호스트는 `https://pockemoney.com` 으로 301. 호스트·프로토콜·슬래시·통합 slug 리디렉션은 한 번의 301로 최종 URL에 도달(다중 리디렉션 금지).
   * GET/HEAD 만 리디렉션(POST API 보호). localhost 는 호스트 리디렉션 제외, 슬래시 정규화는 같은 origin 으로 적용. 410 규칙 유지.
2. **canonical (`SEO.astro`)**: `https://pockemoney.com` + 끝 `/` 를 뗀 pathname (루트는 `/`).
3. **모바일 내비**: 기존 드로어·테마 유지. 토글 `aria-expanded`·`aria-controls`, 드로어 `role="dialog"`·`aria-modal`, 닫힘 상태 `inert`, Esc 닫기, 포커스 이동·복귀·트랩, 현재 메뉴 `aria-current`.
4. **푸터**: 소개·문의·개인정보처리방침·이용약관(/terms) 링크, 모바일 줄바꿈.
5. **사이트맵**: `sitemap.xml` = urlset(정적 URL에 `/terms` 포함, lastmod `+09:00`), `sitemap-index.xml` = `sitemap.xml` 을 가리키는 sitemapindex. robots.txt 는 `sitemap.xml` 만 등록.
6. **홈 h1**: 사이트 주제를 설명하는 보이는 h1 1개.
7. **날짜**: `datePublished`·`dateModified`·`article:published_time`/`modified_time`·`<time datetime>` 를 `YYYY-MM-DDTHH:mm:ss+09:00` 로. D1 `CURRENT_TIMESTAMP` 는 UTC 로 해석 (`src/lib/date.ts`).
8. **AdSense 메타**: `<meta name="google-adsense-account" content="ca-pub-9338927727391440">` (siteConfig 값).

### 3. 범위 외 (사용자 작업)
* `http://www.` 2단 리디렉션: Cloudflare 대시보드에 `www.pockemoney.com/*` → `https://pockemoney.com/${path}` 단일 Redirect Rule 을 두면 1회로 줄어든다.
* `workers_dev: false`(wrangler) 전환은 배포 설정이라 사용자 판단. 코드상 301 로 대응.

### 4. 검증 기준
* `npm run build` 성공, `npm test` 통과
* 로컬 preview: `/about/?a=1` → 301 `/about?a=1`, canonical 끝 `/` 없음, 홈 h1 1개, `google-adsense-account` 메타, sitemap-index 가 sitemapindex
* middleware 단위 검증: www/http/workers.dev + 끝 슬래시 + 통합 slug 조합이 모두 단일 301

---

## 법적 고지·신뢰성

* **작성일:** 2026-10-19
* **상태:** 사용자 지시에 따라 구현 (법적 고지 담당). 동시 편집으로 원문 섹션이 지워져 `@qa` 가 코드·diff 근거로 복원함.

### 1. 배경
* 개인정보처리방침이 GA4·AdSense 일부만 다루고, 처리 목적·보유기간·국외 이전·정보주체 권리·보호책임자 항목이 없었다.
* 이용약관·면책 고지 페이지(`/terms`)가 없었다(라이브 404).
* 개인정보처리방침에 실제로 쓰지 않는 제휴 프로그램(쿠팡 파트너스·알리익스프레스)이 적혀 있었다.
* About 페이지가 운영자·작성 방식(AI 초안·자동 게시)을 밝히지 않았고, 홍보성 문구("놓치면 손해", "실시간 비교")가 있었다.
* 푸터 면책 문구가 "모든 콘텐츠는 … 공식 보도자료 기반"으로 단정했다.

### 2. 요구사항과 적용 결과
1. **`src/pages/privacy.astro`** (시행일 2026-10-19): 처리 목적, 처리 항목·수집 방법(이메일 문의, 자동 수집, localStorage 테마값), Google AdSense 쿠키와 맞춤 광고 거부 링크, GA4(측정 ID `G-HTTFPW8CX1`, 코드와 일치), 제휴 링크 없음, 보유기간·파기, 처리 위탁·국외 이전 표(Google LLC — GA4·AdSense·Google Fonts·Gmail / Cloudflare / jsDelivr — Pretendard 웹폰트, `BaseLayout.astro` 의 외부 리소스와 일치), EEA·영국·스위스 이용자, 정보주체 권리, 안전성 확보, 보호책임자(이메일 `siteConfig.profile.email`), 신고 기관, 변경 고지.
   * CMP: 아직 설정하지 않았으므로 "설정하면 동의 메시지로 동의를 받은 뒤 처리" 로 사실에 맞게 표기(`@qa` 수정).
2. **`src/pages/terms.astro` (신규)**: 정보의 성격(금융·세무 자문 아님, 상품 권유 없음), 기준일·변경 가능성, 공식 기관 확인 권고, 책임 제한, 오류 제보·정정, 광고, 제휴 링크(현재 없음), 저작권, 금지 행위, 문의처, 시행일.
3. **`src/pages/about.astro`**: 다루는 분야, 운영자(개인 1인, 전문 자격 기관 아님), 글을 만드는 방식(Google Gemini 초안, 일부 글 정해진 일정에 자동 생성·게시 — `scripts/lib/llm.mjs`·`scripts/auto-publish-runner.mjs` 와 일치, 게시 후 공식 자료 대조), 광고·제휴(현재 제휴 없음), 오류 제보·정정.
4. **푸터 면책 문구** (`src/components/Footer.astro`, `@qa` 수정): "포켓머니의 글은 정부 부처·공공기관이 공개한 자료를 바탕으로 이해하기 쉽게 정리한 생활 정보이며, 글마다 확인한 기준일과 출처를 적어 둡니다. 제도와 금리는 바뀔 수 있으므로 신청 전 소관 기관의 최신 공고를 확인하세요. 이 사이트의 글은 투자·법률·세무 자문이 아닙니다."
5. 푸터·사이트맵에 `/terms` 연결은 `## 플랫폼` 범위에서 처리.

### 3. 범위 외 (사용자 작업)
* AdSense 계정의 "개인정보 보호 및 메시지"에서 Google 인증 CMP(EEA·영국·스위스) 설정. 설정 후 개인정보처리방침 8항을 "동의를 받은 뒤 처리합니다" 로 갱신.

---

## QA

* **검수일:** 2026-10-19 · **검수자:** `@qa`
* **사양서 무결성:** `## 콘텐츠·이미지`, `## 플랫폼` 은 남아 있었고 `## 법적 고지·신뢰성` 이 지워져 있어 코드·diff 근거로 복원.

### 1. 코드
* `src/middleware.ts`: esbuild 로 변환해 14개 케이스 단위 검증. http/www/workers.dev/대문자 호스트 + 끝 슬래시 + 통합 slug 조합이 모두 단일 301(`https://pockemoney.com…`, 쿼리 보존), POST 는 통과, 410(숫자 접두 slug·`/category/news`) 유지, localhost 는 같은 origin 으로 슬래시만 정규화. Location 은 항상 고정 origin + 경로라 오픈 리디렉션 없음(`//evil.com/` → `https://pockemoney.com//evil.com`).
* `SEO.astro` canonical(끝 `/` 제거), `lib/date.ts`(D1 UTC → `+09:00`), `[slug].astro`·`PostCard` `<time datetime>`, `dateModified`·`article:modified_time`, `BaseLayout` `google-adsense-account` 메타, robots(sitemap.xml 만)·sitemap(`/terms` 포함, lastmod `+09:00`)·sitemap-index(sitemapindex), 홈 h1 1개, Header 드로어(`aria-expanded`/`aria-controls`/`role=dialog`/`aria-modal`/`inert`/Esc/포커스 트랩·복귀/`aria-current`), Footer `/terms` 링크 — 코드 리뷰 및 로컬 렌더링으로 확인.
* 로컬 `wrangler dev --local --local-upstream localhost:8799 --persist-to <scratchpad>` (빌드 산출물, 로컬 D1 에 마이그레이션 + 테스트 글 1건): `/`·`/about`·`/terms`·`/privacy`·sitemap·robots·글 200, `/about/?a=1`·글 끝 슬래시·통합 slug 끝 슬래시 → 단일 301, 410·404 정상, 정적 이미지 200. 확인 후 종료.
  * 참고: `--local-upstream` 없이 실행하면 wrangler 가 요청을 `http://pockemoney.com` 으로 바꿔 넘겨 `/` 가 자기 자신으로 301 되는 것처럼 보인다(로컬 개발 환경 현상, 운영 영향 없음).
* `ASTRO_TELEMETRY_DISABLED=1 XDG_CONFIG_HOME=<scratchpad> npm run build` 성공, `npm test` 통과.

### 2. 법적 페이지
* 서비스 목록이 코드와 일치(GA4 `G-HTTFPW8CX1`, AdSense `ca-pub-9338927727391440`, Google Fonts, jsDelivr Pretendard, Cloudflare, 제휴 없음 — `AffiliateNotice` 는 `affiliate_disclosure=1` 일 때만 표시, 24편 모두 제휴 링크 없음).
* 수정: 개인정보처리방침 8항 CMP 문구를 미설정 사실에 맞게 변경. 푸터 면책 문구 교체.

### 3. 콘텐츠·이미지 (24편)
* frontmatter: slug·date 변경 0, 제목 콜론 0, `featured_image`·`og_image` 파일 24/24 실존, 본문 이미지 경로 전부 실존·사이트 내부. 24편 모두 기준일 표기.
* 출처 링크 78개 curl: 76개 200, molit 2개는 쿠키 필요(브라우저 헤더로 200). nhis `wbhada07500m01.do`(모의계산)는 "페이지가 삭제되었거나 주소가 변경" → 링크 삭제·본문 안내 문구 수정.
* 팩트체크(공식 출처 대조): 카드 소득공제(정책브리핑 2025.10.30·12.22), 건강보험 피부양자(건보공단 기준 페이지), 신생아 특례대출(마이홈포털 상품 안내) — 수치 일치. 카드 소득공제 글의 자녀 수 한도 상향은 2026.1.1 이후 사용분부터라 "2025년 귀속 기준" 서술과 섞여 있어 본문·인포그래픽(`threshold.svg/.webp`)에 적용 시점 명시.
* 이미지-본문 일치 표본: 카드 소득공제(수정 후 일치), 건강보험 피부양자, 청년월세(중위 60%·153만 8천원·24개월) 일치.
* 이미지: 24개 폴더, 래스터 71개, cover/og 전부 1200×630, 최대 300KB 미만, 외부 이미지·`<image>` 참조 없음.
* 확정적 투자 권유 표현 없음.

### 4. 남은 이슈 (승인에 영향 없음)
* 언론 기사 출처 3건(헤럴드경제·한국일보·파이낸셜뉴스)은 공식 출처 보조로 남아 있음. 해당 보도자료 원문으로 교체 권장.
* `content/posts/youth-leap-account-2026-guide.jpg`(604KB, 추적 중)는 어떤 글에서도 참조하지 않음 — 유지, 정리 여부는 사용자 판단.
* `http://www.` 2단 리디렉션(엣지 Always Use HTTPS)과 `workers_dev` 비활성화는 Cloudflare 설정 범위.
* 배포 순서: 사이트 배포 → D1 재발행(이미지가 정적 자산이므로).

**QA 승인 서명:** @qa — 2026-10-19 — 플랫폼(middleware·SEO·날짜·내비·푸터·사이트맵/robots·AdSense 메타), 법적 고지(privacy·terms·about·푸터 면책), 콘텐츠 24편·이미지 24세트 (data/ 및 자동 발행 데몬 신규 글 제외)

---

## QA — 26102001 국민내일배움카드

* **검수일:** 2026-10-21 · **검수자:** `@qa`
* **대상:** `content/posts/26102001-national-tomorrow-learning-card-2026-guide.md`, `public/assets/posts/national-tomorrow-learning-card-2026-guide/` (`cover.webp`·`og.jpg`·`structure.webp`, 원본 SVG 동봉)

### 1. 팩트체크 (공식 출처 원문 대조)
* 대조 자료: 고용24 제도 안내(최종 수정 2026-07-27)·발급 안내 원문, 고용노동부 정책 소개, 정책브리핑 2025.1.2 기사·2025.12.31 카드뉴스, 고용노동부고시 「국민내일배움카드 운영규정」 일부개정(2026.1.1 시행) 개정 전문·신구조문대비표(hwpx 본문 추출).
* 일치: 기본 300만원·추가 200만원·총 500만원(2025.1.1 시행, 100만→200만원), 추가 지원 대상 11개 유형(운영규정 제14조), 유효기간 5년·만료 시 잔액 소멸(제16조), 자부담 0~55%(통상 15~55%), 가정 밖 청소년 15~55%→0~20%, 제외 대상(75세, 대규모기업 45세 미만·월 300만원, 특고 월 500만원, 자영업자 1년 미만·매출 4억원, 재학생, 생계급여 조건부 예외), 장려금 2,500원/5만원·5,800원/11만 6천원·자영업자 36만원·출석률 80%·실업급여 수급 시 미지급 가능, 발급 4단계·우편/은행 수령, 과정 6개 분류(정책브리핑 카드뉴스).
* 수정(본문):
  * 구직 신청 단계 "재직자·자영업자는 필요 없음" → 국가기간·K-디지털·일반고 특화·돌봄 특화는 재직자도 구직 신청 필요(고용24 발급 안내).
  * 2026.1.1 개정분 반영: 외국인근로자(E-9·H-2) 피보험자 발급 대상 포함, 특화훈련(국기·KDT·산대특·일반고) 훈련비 90% 이상·본인 부담 최대 60만원·1회·잔액 차감 간주액, 특화훈련 장려금 월 20만원, 특별훈련수당(350시간 이상, 월 10만~30만원). 기준일 note 가 "개정분 반영"이라고 적었으나 실제 반영이 없어 보강.
  * 장려금 조건 보강: 140시간 이상 과정, 단위기간 정의, 월 60시간(주 15시간) 미만 피보험자("월 15시간"은 오기), 원격훈련 제외, 만족도 조사 미제출 시 마지막 달 미지급.
  * 제외 대상 보강: 법인 대표·비영리단체 대표, 군인, 생계급여 조건부 예외, 대규모기업 예외(기간제·육아휴직 등), 고용보험 피보험자 단서(제4조제3항).
  * 추가 200만원은 300만원 소진 후 유효기간 내 1회·고용센터 방문 신청임을 명시.
  * 부정수급 경고: 검증 못 한 "형사 처벌" 문구 삭제, 공식 문구(최대 5배 반환·지원 중단)와 중도 포기 한도 차감(20/50/100만원, 원격 4/10/20만원)으로 교체.
  * 국기 FAQ·재직자 FAQ를 운영규정 기준으로 정정, 굵은 글씨 3곳→2곳, `reading_time` 6→7.
* 수정(이미지): `structure.svg` 문구 3곳(최대 한도 "과정 종류와 무관"→"계좌 한도 기준", 자부담 "통상 15~55%", 장려금 "월 11.6만원(일반)·140시간 이상 과정") → sharp(density 144, 폭 1200, webp q90)로 재생성, 1200×770 유지. `cover.webp`·`og.jpg` 는 본문과 일치해 변경 없음(1200×630).

### 2. 형식
* frontmatter: `author: "포켓머니"`, `featured_image`·`og_image`·`image_width: 1200`·`image_height: 630`, slug 변경 없음, 제목 콜론 없음. 이미지 경로 3개 실존(`/assets/posts/<slug>/`), 본문 이미지 webp + 대체 텍스트 + 기준일 캡션, 이미지 안 기준일 2026.10.21 표기.
* 마크다운: `:::note`·`:::warning` 짝 맞음, 표 3열, 다중 공백 없음, H2 7개·H3 5개, 본문 공백 포함 약 5,900자.
* 출처 링크 6개 curl 200.

### 3. 남은 이슈 (승인에 영향 없음)
* 고용24 화면 일부는 국가기간 등 특화훈련을 "1회 본인 부담 없이 전액 지원"으로 안내해 2026 운영규정(90% 이상, 최대 60만원)과 다름 — 본문은 운영규정을 따르고 차이를 명시함.
* 실업급여 수급 중 훈련 수강의 재취업활동 인정 여부는 공식 원문으로 확인하지 못해 "고용센터 상담" 수준으로 표현.
* 이미지 재생성 시 글꼴은 기존 생성과 같은 NanumGothic(작업 공간 공용 `scripts/nanumgothic.ttf`, 읽기 전용) 사용.

**QA 승인 서명:** @qa — 2026-10-21 — 26102001 국민내일배움카드 글 재작성·팩트체크·이미지 3개
