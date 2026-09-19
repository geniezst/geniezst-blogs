# [사양서] blogs Fumika 공식 테마 레이아웃 정리 및 고도화

- **작성일:** 2026-09-19
- **작성자:** @pm (제품 관리자)
- **적용 대상:** `/workspace/blogs`
- **목표:**
  1. `blogs`의 어수선한 중복 요소(가로 스크롤 칩 바, 과도한 피처드 블록)를 정리하고 공식 Fumika 테마 구조로 완벽히 일원화.
  2. 상단 내비게이션 바를 Fumika 원본 규격(`sticky top-0`, `!rounded-t-none rounded-b-2xl`)으로 일치시켜 브라우저 최상단에 밀착된 일관된 디자인 확보.
  3. 포스트 카드를 Fumika 공식 사양(세로 에메랄드 인디케이터, 28% 우측 데스크톱 썸네일 + 줌 오버레이, 미보유 시 엔터 버튼)으로 통일.

---

## 1. 컴포넌트별 개선 사양

### 1.1 상단 내비게이션 바 (`src/components/Header.astro`)
- 화면 상단 밀착형 (`sticky top-0 z-50 w-full mb-6 sm:mb-8`).
- `card-base !rounded-t-none rounded-b-2xl max-w-6xl mx-auto h-[4.5rem] px-4 sm:px-6 flex items-center justify-between border-t-0 shadow-md backdrop-blur-md`.
- 좌측: Fumika 에메랄드 홈 아이콘 + 사이트명(`스마트 라이프 & 머니`).
- 중앙: `scale-animation` 내비게이션 링크.
- 우측: 검색 버튼 + 테마 토글.

### 1.2 메인 페이지 정리 (`src/pages/index.astro`)
- 기존의 복잡했던 수평 칩 필터 바 제거 (사이드바 카테고리와의 중복 해소).
- 깔끔한 Fumika 웰컴 배너 카드 배치:
  - 에메랄드 은은한 그라디언트 + 명확한 헤드라인.
- 최신 포스트 피드:
  - 정리된 피드 헤더 (`최신 정책 가이드 (Recent Posts)` + `전체 보기 ({total}) →`).
  - 정돈된 `PostCard` 목록.

### 1.3 포스트 카드 (`src/components/PostCard.astro`)
- `card-base flex flex-col-reverse md:flex-col w-full rounded-2xl overflow-hidden relative group hover:shadow-xl transition-all duration-300 p-5 sm:p-6`.
- Fumika 시그니처 세로 에메랄드 인디케이터 바 (`before:w-1.5 before:h-5 before:rounded-md before:bg-emerald-600 dark:before:bg-emerald-400 before:absolute before:top-1.5 before:-left-4 before:hidden md:before:block`).
- 데스크톱 28% 우측 썸네일 & 줌 오버레이 화살표.
- 썸네일 미보유 시 우측 에메랄드 엔터 화살표 버튼.
- 하단 모바일 대시 구분선.

### 1.4 사이드바 (`src/components/Sidebar.astro`)
- 작성자 이름 하단 Fumika 시그니처 에메랄드 언더라인 바 (`h-1 w-6 bg-emerald-600 dark:bg-emerald-400 mx-auto rounded-full my-2.5`).
- 통계 바 및 🛡️ 100% 공공데이터 기준 검증 뱃지(상하 여백 14px 균등).
- 카테고리 아코디언 토글(모바일 기본 접힘, 데스크톱 항상 펼침).
