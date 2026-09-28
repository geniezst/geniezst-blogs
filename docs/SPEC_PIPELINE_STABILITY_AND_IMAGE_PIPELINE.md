# SPEC: 자동 게시 파이프라인 안정화 및 원본 이미지 파이프라인 정상화

- 작성자: PM
- 상태: 승인됨 (사용자 승인 완료, 2026-09-27)
- 대상 저장소: `/workspace/projects/blog` (1호 IT/테크, geniezst.com), `/workspace/projects/blogs` (2호 포켓머니, pockemoney.com)
- 공통 목표: ① 자동 게시 실패 제거 ② 출처 사진 100% 확보 및 R2 정상화 ③ 화면 표시 크기 정상화

---

## 1. 확정 결정 사항

| 항목 | 결정 |
|---|---|
| 수정 범위 | 두 프로젝트 동시. 공용 로직은 `scripts/lib/` 로 추출해 동일 사본 유지 |
| 대표 이미지 | 다이제스트 **첫 번째 카드 이미지**를 `featured_image` 로 승격. 기존 `news` 카테고리 글에도 소급 적용 |
| LLM | Groq 단계 삭제, agy Tier 1 삭제 → Gemini 네이티브 단일 경로 |
| 이미지 처리 | `sharp` 0.35.4 (기 설치됨) 1200px 정규화 + WebP 변환 |
| GitHub 인증 | PAT 회전 + credential helper 전환, 원격 URL 평문 토큰 제거 |

---

## 2. 요구사항 (Functional Requirements)

### FR-1. 원본 이미지 수집 보장
- **FR-1.1** 이미지로 사용되는 바이트는 반드시 실제 이미지 포맷이어야 한다. 매직 바이트 스니핑으로 판정하며 HTML·에러 페이지를 100% 기각한다.
- **FR-1.2** `Content-Type` 이 `image/*` 가 아니면 다운로드를 거부한다. (기존 `|| !ct` 분기 제거)
- **FR-1.3** 기사 출처를 `Referer` 헤더로 전달하고 `Accept-Language: ko-KR` 을 명시한다.
- **FR-1.4** 썸네일 URL 에서 원본 후보를 복원하고, 실제 픽셀 면적을 비교해 최대 해상도 이미지를 선택한다.
- **FR-1.5** 최종 이미지는 가로 최소 640px 를 확보한다. 미달이면 동일 출처의 다른 후보로 대체한다.
- **FR-1.6** 실패 시 무음 제거하지 않는다. 동일 출처 대체 후보를 시도하고, 최종 실패 시 텔레그램에 건수를 보고한다.

### FR-2. R2 저장 및 서빙
- **FR-2.1** R2 오브젝트 키에 **콘텐츠 해시**를 포함해 동일 슬러그의 이미지 교체 시 URL 이 변경된다.
- **FR-2.2** 확장자 및 `Content-Type` 은 **바이트에서 판정한 실제 포맷**을 사용한다. (URL 확장자 추종 금지)
- **FR-2.3** 업로드는 실행 결과를 로깅하고, 실패 시 조용히 넘어가지 않는다.
- **FR-2.4** `images` 는 가로 최대 1600px, WebP 포맷으로 정규화한다. 초과분은 축소하고 저해상도 이미지는 업스케일 금지.

### FR-3. 이미지 표시
- **FR-3.1** 목록 카드 이미지는 종횡비를 고정(`aspect-[16/10]`)하고 `object-cover object-center` 로 중앙 크롭한다.
- **FR-3.2** 본문·상세 이미지에는 `width`/`height` 속성을 출력해 CLS 를 제거한다.
- **FR-3.3** 세로형 이미지가 `max-h` 로 잘리는 문제를 제거한다.
- **FR-3.4** 이미지 로드 실패 시 기본 placeholder 로 교체한다.
- **FR-3.5** `og:image` 기본값이 `favicon.svg` 인 상태를 제거하고 1200×630 정적 이미지로 교체하며 `og:image:width/height/alt` 를 출력한다.

### FR-4. 게시 파이프라인 신뢰성
- **FR-4.1** `git pull --rebase` 실패를 삼키지 않는다. 실패 시 원격 반영 없이 중단하고 텔레그램으로 경보한다.
- **FR-4.2** 모든 git 호출에 `safe.directory` 를 주입해 소유권 오류를 제거한다.
- **FR-4.3** 런타임 상태 파일(`data/*.json`)은 Git 추적 대상에서 제외한다.
- **FR-4.4** 저녁 심층글은 H2 5개 미만 또는 공백 제외 1,800자 미만이면 **D1 발행 전에 차단**한다. 자동 재시도 1회 후에도 미달이면 발행 스킵 + 경보.
- **FR-4.5** LLM 응답이 `MAX_TOKENS` 로 잘렸다면 성공으로 처리하지 않는다.
- **FR-4.6** 텔레그램 메시지는 3900자 단위로 분할 전송한다.
- **FR-4.7** 검수 데몬(`correct-runner`)의 감사 실패를 "위반 0건"으로 변환하지 않는다.
- **FR-4.8** 로그가 중복 기록되지 않고, 로그 회전과 데몬 자동 재시작이 동작한다.

---

## 3. 비요구사항 (Non-Goals)
- 무관한 대체 이미지(스톡·AI 생성·다른 매체 사진) 도입 금지. 동일 출처 검증 이미지만 사용한다.
- 캐시 CDN/Cloudflare Image Resizing 도입 금지. `sharp` 로 빌드 시점에 정규화한다.
- Playwright E2E 는 사용자 승인 없이 실행하지 않는다.

---

## 4. 구현 항목

### 4.1 공용 모듈 (`scripts/lib/`, 양쪽 동일 사본)
| 파일 | 책임 |
|---|---|
| `logger.mjs` | stdout 과 로그 파일의 동일 inode 비교로 중복 기록 제거 |
| `runtime-lock.mjs` | `O_EXCL` 락, 죽은 PID 자동 회수, 시그널 정리 |
| `git-publish.mjs` | `safe.directory` 주입, `add→commit→fetch→rebase→push`, 실패 시 `rebase --abort` 후 throw |
| `llm.mjs` | Gemini 네이티브 단일 경로, `thinkingBudget:0`, `MAX_TOKENS` 감지 |
| `image-pipeline.mjs` | 매직 바이트 판별, `Referer` 다운로드, HD 후보 생성, sharp 정규화, R2 업로드 |

### 4.2 백엔드 (`@backend`)
- `auto-publish-runner.mjs` — git 단계 교체, LLM 교체(Groq/agy 제거), 무결성 게이트 throw, 잠금 적용
- `generate-news-digest.mjs` — 이미지 파이프라인 교체, 카드별 결정 로직, `featured_image` 승격
- `publish-post.mjs` — R2 키 해시화, 대표 이미지 저장 경로
- `telegram-notify.mjs` — 청크 분할
- `correct-runner.mjs` — 감사 실패 표면화
- `.gitignore` — `data/*.json` 제외
- 신규 `scripts/backfill-featured-image.mjs` — 기존 `news` 글 소급 적용
- 신규 D1 마이그레이션 — `featured_image` 인덱스

### 4.3 프론트엔드 (`@frontend`)
- `PostCard.astro` — 종횡비 고정, 크롭 중앙 정렬, `width/height`
- `blog/[slug].astro` — `max-h` 제거 또는 컨테이너 대응
- `lib/markdown.ts` — `<figure>` 정상 중첩, `width/height/decoding`
- `styles/article.css` — Tailwind 와 충돌하는 전역 이미지 규칙 정리
- `components/SEO.astro` — OG 이미지 정적 대체 + 메타 추가
- `pages/rss.xml.ts` — `enclosure` / `media:content`

### 4.4 운영 (`/workspace/service.sh`)
- `correct-runner` 2종 등록, 자동 재시작, 로그 회전

---

## 5. 수용 기준 (Acceptance Criteria)
- **AC-1** `node --check` 가 양쪽 `scripts/*.mjs` 전부 통과한다.
- **AC-2** `npm run build` 가 양쪽 성공한다.
- **AC-3** `--dry-run` 실행에서 모든 카드가 이미지 1개 이상을 확보하고 H2 ≥ 4, 공백 제외 ≥ 1,500자를 만족한다.
- **AC-4** 상태 파일을 dirty 로 만든 상태에서 배포 헬퍼를 실행해도 원격 반영이 성공한다.
- **AC-5** 저분량 글이 의도적으로 주입되면 D1 발행 전에 차단된다.
- **AC-6** 라이브 `/api/images/*` 응답의 `Content-Type` 이 실제 바이트 포맷과 일치한다.
- **AC-7** 목록·상세 HTML 에 `og:image` 가 1200×630 PNG/WebP 로 출력되고 `og:image:width` 가 존재한다.
- **AC-8** 기존 `news` 카테고리 전 글의 `featured_image` 가 채워진다.
- **AC-9** 텔레그램 장문 전송이 성공한다.

---

## 6. 검증 방법
1. 정적 검사: `node --check` (전 스크립트), `npm run build`
2. 이미지 파이프라인 단위 테스트: HTML 페이지·빈 `Content-Type`·확장자 없는 PNG·`_l` 썸네일 픽스처
3. `--dry-run` 파이프라인 검증
4. Git 시뮬레이션 (dirty 상태에서 성공 확인)
5. 저분량 글 차단 테스트
6. 라이브 `curl` 로 MIME·크기·`width/height`·OG 이미지 확인
7. `@qa` 감사 및 승인

> Playwright E2E 는 사용자 지시 시에만 수동 실행한다.
