# 포켓머니 (pockemoney)

대한민국 청년, 직장인, 서민, 소상공인을 위한 **정부 지원금, 숨은 환급금, 스마트 절세 및 생활 금융 가이드** 전문 블로그입니다.

* **대표 도메인:** [https://pockemoney.com](https://pockemoney.com) (www: [https://www.pockemoney.com](https://www.pockemoney.com) ➔ 301 영구 리디렉션)
* **Worker 원본:** [https://blogs.geniezst.workers.dev](https://blogs.geniezst.workers.dev)
* **저장소:** [geniezst/geniezst-blogs](https://github.com/geniezst/geniezst-blogs) (`main` 브랜치)
* **배포 방식:** GitHub push ➔ Cloudflare Workers 자동 빌드 및 엣지 배포
* **텔레그램 알림 & 커맨드 센터:** `@antigravity_jin_bot`

---

## 🏛️ 주요 카테고리 (6대 금융/복지 영역)

1. **정부 지원금 & 복지 (`welfare`):** 청년도약계좌, 국민취업지원제도, 근로·자녀장려금, 부모급여 등 전 국민 정책 금융
2. **연말정산 & 환급/절세 (`tax`):** 숨은 환급금 조회, 소득공제 황금비율, 종합소득세 및 건강보험료 절세 실전 가이드
3. **예적금 & 금융 꿀팁 (`finance`):** 고금리 파킹통장, 특판 예적금, 청약통장 및 ISA 절세 계좌 전환 전략
4. **생활비 절약 & 공과금 (`saving`):** 전기·가스요금 캐시백, 알뜰폰 요금제, 대중교통 K-패스, 카드 피킹 노하우
5. **소상공인 & 정책자금 (`subsidy`):** 소상공인 전기요금 특별지원, 저금리 대환 대출, 폐업/재창업 지원금
6. **생활 행정 & 필수 팁 (`life-tips`):** 정부24 민원 서류 원스톱 발급, 착한운전 마일리지, 일상 행정 상식

---

## 🛠️ 기술 스택 (Tech Stack)

* **Framework:** Astro 7 (SSR 모드)
* **Edge Runtime:** Cloudflare Workers (`@astrojs/cloudflare`)
* **Database:** Cloudflare D1 (`blogs` / `cda318ea-89f1-45f8-84a6-11b44f758d6e`)
* **Object Storage:** Cloudflare R2 (`blogs`)
* **Styling & Design System:** Tailwind CSS v4, Shirone M3 Glassmorphism Theme (Fintech Emerald Palette)
* **Branding:** `Titan One` 기반 포켓몬풍 `pockemoney` 히어로 타이포그래피 (그림자 잘림 방지, 정적 입체 섀도우)
* **Markdown Parser:** Marked v15 커스텀 렌더러 (코드 블록, 표 서브텍스트 변환, 수치 시각화 차트)

---

## ✨ 최근 주요 개선 및 아키텍처 특징

1. **커스텀 도메인 & SEO 영구 리디렉션 미들웨어**
   * `pockemoney.com` 대표 도메인 연동 및 검색엔진 표준(Canonical) URL, 사이트맵, RSS 완벽 동기화.
   * [`src/middleware.ts`](src/middleware.ts): `www.pockemoney.com` 접속 요청 시 쿼리와 경로를 유지하며 `https://pockemoney.com`으로 301 영구 리디렉션 처리.
2. **컨텐츠 영역 가로폭 초과 (Overflow) 원천 방어 (Defensive Design)**
   * Flexbox 기본값(`min-width: auto`)으로 인한 부모 카드 팽창을 방지하기 위해 `<article>`에 `min-w-0` 및 `overflow-hidden` 적용.
   * 긴 인라인 코드(`:not(pre) > code`) 및 긴 URL에 `word-break: break-all; overflow-wrap: anywhere;` 강제 적용.
3. **표(Table) 괄호 줄바꿈 서브텍스트 및 슬림 가로 스크롤바**
   * 표 셀(`<td>`) 내 `약 542만원 (세후 15.4% 과세)` 형태의 부연 설명을 `<br><span class="table-subtext">...</span>`로 자동 분리하여 정보 위계 및 가독성 극대화 (링크, 인라인 코드, 셀 선두 괄호 엣지 케이스 완벽 보호).
   * 내용이 넘칠 때만 나타나는 5px 슬림 미니멀 가로 스크롤바(Firefox/WebKit/모바일 터치) 적용.
4. **자연스러운 주 1회 랜덤 휴식 시뮬레이션 데몬**
   * 일일 2회(점심 11:15~11:45, 저녁 18:15~18:45) KST 랜덤 시간에 자동 포스팅.
   * 주 1회 랜덤 요일에는 점심 세션을 쉬고 저녁 1회만 발행하는 주간 변칙 알고리즘 상시 구동.

---

## 🚀 로컬 개발 및 일상 운영 명령어

모든 명령어는 `/workspace/blogs` 디렉토리에서 실행합니다.

```bash
# 1. 로컬 개발 서버 실행
npm run dev

# 2. 프로덕션 빌드 검증
npm run build

# 3. D1 원격 마이그레이션 적용
npm run d1:migrate

# 4. 신규 마크다운 포스트 D1 원격 DB 수동 등록
node scripts/publish-post.mjs content/posts/YYMMDDNN-<post-slug>.md

# 5. 자동 발행 스케줄러 수동 즉시 실행 (점심/저녁)
node scripts/auto-publish-runner.mjs lunch
node scripts/auto-publish-runner.mjs evening

# 6. 스케줄러 데몬 무중단 백그라운드 가동
setsid node scripts/auto-publish-runner.mjs daemon >> data/auto-publish.log 2>&1 &
```
