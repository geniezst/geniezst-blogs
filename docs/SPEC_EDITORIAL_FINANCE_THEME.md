# [기능 및 테마 개편 사양서] 스마트 머니 & 복지 에디토리얼 매거진 테마 구축 및 버그 수정
**작성자:** `@pm` (Product Manager)  
**작성일:** 2026-09-18  
**상태:** 승인 대기 / 구현 진행  
**대상 워크스페이스:** `/workspace/blogs`

---

## 1. 개요 및 목표

사용자 피드백에 따라 다음 3가지 핵심 문제를 해결하고, "생활 경제 & 정부 복지 / 알뜰 머니" 주제에 최적화된 새로운 고품격 에디토리얼 매거진 테마를 전면 적용합니다:
1. **[버그 해결] R2 이미지 500 에러 및 깨짐 현상 수정**: Astro v6 / Cloudflare Workers 환경에서 `Astro.locals.runtime.env` 제거에 따른 바인딩 오류 수정 (`import { env } from 'cloudflare:workers'`).
2. **[버그 해결] 포스트 수 및 카테고리별 글 수 0 표기 문제 수정**: D1 쿼리 최적화(`post_count` 서브쿼리 연동) 및 컴포넌트(`Sidebar.astro`, `[slug].astro`, `[category].astro`) 누락 전달 방지 로직 구축.
3. **[테마 개편] 생활 금융 에디토리얼 매거진 테마 전면 교체**: 기존 테크용 Fuwari 카드 디자인을 탈피하고, 토스 피드/뱅크샐러드/어피티 스타일의 신뢰감 높고 가독성 뛰어난 "Smart Money Editorial Magazine" 테마 구축.

---

## 2. 작업 단위 명세 (Work Breakdown Structure)

### 2.1. `@backend` 작업 명세
1. **`src/pages/api/images/[...path].ts` 수정:**
   - Astro v6 호환 `import { env } from 'cloudflare:workers'` 적용.
   - `env.BUCKET` 또는 `(locals as any)?.runtime?.env?.BUCKET` 안전 폴백.
   - R2 캐싱 헤더(`public, max-age=31536000, immutable`) 및 ETag 검증.
2. **`src/lib/db.ts` 쿼리 및 헬퍼 개선:**
   - `getCategories(db)`: 각 카테고리별 `post_count`를 실시간 서브쿼리로 조회.
     ```sql
     SELECT c.*, (
       SELECT COUNT(*) FROM blog_posts p 
       WHERE p.category_id = c.id AND p.status = 'published'
     ) as post_count
     FROM blog_categories c ORDER BY c.order_index ASC
     ```
   - `getTotalPublishedPosts(db)` 헬퍼 함수 추가: 전체 발행 포스트 개수 단독 조회 제공.

---

### 2.2. `@frontend` 작업 명세
1. **신규 테마 디자인 컨셉: "Smart Money & Life Welfare Editorial Magazine"**:
   - **컬러 팔레트:**
     - 메인: 신뢰의 딥 포레스트 에메랄드 (`#065f46`, `#059669`, `#10b981`)
     - 서브: 웜 앰버 골드 (`#d97706`, `#f59e0b`) - 혜택/환급 강조
     - 배경: 소프트 페이퍼 크림 웜톤 (`#f8fafc` / 다크: `#0b131f`)
     - 텍스트: 프리미엄 딥 슬레이트 (`#0f172a` / 다크: `#f8fafc`)
2. **레이아웃 및 컴포넌트 전면 재설계:**
   - `Header.astro`:
     - 상단 마스트헤드 티커: "📢 2026 정부 정책 금융 및 숨은 환급금 통합 가이드 | 오늘 날짜"
     - 브랜드 로고: 금융 방패 & 상승 화살표 아이콘 + "스마트 라이프 & 머니"
     - 퀵 카테고리 탭 내비게이션 + 검색창 + 다크모드 토글
   - `HeroFeatured.astro` (신규):
     - 에디터 추천 Top Story 대형 배너 (청년도약계좌 등 주요 복지 정책 대형 썸네일 + 핵심 요약 + 혜택 뱃지)
   - `PostCard.astro`:
     - 에디토리얼 매거진 카드: 썸네일 뱃지, 카테고리 컬러 태그, 신청 대상 뱃지, 읽는 시간, 조회수, 발행일
   - `Sidebar.astro`:
     - 에디토리얼 자격 뱃지 (공식 정부 정책 100% 검증)
     - 전체 포스트 수 및 카테고리별 포스트 수 자동 계산 (`totalPosts` 누락 시 카테고리 합계로 폴백)
     - "이달의 필수 지원금 체크리스트" 위젯 (청년도약계좌, 근로장려금, 건강보험 환급 등)
     - 뉴스레터 & RSS 구독 카드
   - `src/pages/index.astro`:
     - 히어로 추천 기사 + 최신 가이드 그리드 + 카테고리 필터
   - `src/pages/blog/[slug].astro`:
     - 아티클 본문 가독성 극대화: 3줄 핵심 요약 박스, R2 연동 대표 삽화 고화질 렌더링, 핀테크 스타일 금융 비교 표(Table), 단계별 번호 리스트, FAQ 아코디언, 저작권 및 제휴 표기
   - `src/styles/global.css` & `article.css`:
     - 매거진 전용 타이포그래피 및 에디토리얼 카드 스타일 정의.

---

## 3. 검증 및 완료 기준 (QA Acceptance Criteria)
1. `/api/images/2026/09/youth-leap-account-2026-guide.jpg` 호출 시 HTTP 200 반환 및 실제 이미지 정상 렌더링.
2. 홈(`/`), 목록(`/blog`), 카테고리(`/category/...`), 상세(`/blog/...`) 모든 페이지에서 포스트 카운트가 `0`이 아닌 실제 개수(`1` 이상)로 정확히 표시될 것.
3. 카테고리별 포스트 수(`post_count`)가 각 항목 옆에 올바르게 표기될 것.
4. 신규 에디토리얼 테마가 라이트/다크 모드에서 깨짐 없이 완벽하게 렌더링될 것.
5. `npm run build` 빌드 성공 (0 에러).
6. `@qa` 최종 감사 보고서 작성 및 승인 서명.
