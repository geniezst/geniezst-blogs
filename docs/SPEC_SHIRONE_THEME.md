# [사양서] blogs Shirone 공식 테마 전면 교체 (Shirone Theme Specification)

- **작성일:** 2026-09-19
- **작성자:** @pm (제품 관리자)
- **적용 대상:** `/workspace/blogs`
- **목표:** 공식 Shirone(`https://github.com/LyraVoid/Shirone` / `https://astro.build/themes/details/shirone/`) 테마의 Material 3 Expressive(M3E) 디자인 시스템과 로즈/사쿠라 핑크-퍼플 팔레트, Top App Bar, M3 PostCard, 배너 시스템을 100% 전면 적용.

---

## 1. Material 3 Expressive 디자인 토큰 및 컬러 시스템
- **주색상 (Primary):** Rose / Sakura Pink (Hue: 315)
  - Light: `#be185d` (Primary), `#fce7f3` (Primary Container), `#500724` (On Primary Container)
  - Dark: `#f472b6` (Primary), `#831843` (Primary Container), `#fbcfe8` (On Primary Container)
- **보조색상 (Secondary / Tertiary):**
  - Secondary: Violet (`#9333ea` / `#c084fc`)
  - Tertiary: Sky Blue (`#0284c7` / `#38bdf8`)
- **표면 (Surface / Card Background):**
  - Light: `#fdf4f8` (Page), `#ffffff` (Card Container), `rgba(226, 232, 240, 0.8)` (Outline Variant)
  - Dark: `#140c14` (Page), `#1f141f` (Card Container), `rgba(255, 255, 255, 0.08)` (Outline Variant)
- **라운드 (Shape Corners):**
  - Large: `1.25rem` (20px), Full: `9999px`

---

## 2. 상단 내비게이션 바 (Top App Bar - `Header.astro`)
- **스타일:**
  - `sticky top-0 z-50 w-full mb-6 sm:mb-8`
  - `border-b border-[var(--outline-variant)] bg-[var(--card-bg)]/85 backdrop-blur-md shadow-xs !rounded-t-none rounded-b-2xl max-w-6xl mx-auto h-[4.5rem] px-4 sm:px-6 flex items-center justify-between`
- **로고 브랜딩:**
  - Shirone 시그니처: 호버 시 늘어나는 세로 필 바 (`span class="h-5 w-1 rounded-full bg-[var(--primary)] transition-all group-hover:h-7"`) + 타이틀 (`스마트 라이프 & 머니`).
- **메뉴 링크:**
  - M3 State Layer 스타일: `px-4 py-2 rounded-full text-sm font-bold text-neutral-700 dark:text-neutral-200 hover:text-[var(--primary)] hover:bg-[var(--primary)]/10 transition-all`.
- **우측 액션:**
  - 빠른 검색 버튼 + 부드러운 다크모드 스위치.

---

## 3. 상단 히어로 배너 (`BaseLayout.astro`)
- Shirone 공식 데스크톱 배너 이미지 (`/assets/images/banner-shirone.webp`) 적용.
- 미세 다크 오버레이(`dim: 0.24`) 및 하단 자연스러운 그라디언트 페이드.
- 우측 하단 크레딧: `Shirone • Material 3 Expressive Theme`.

---

## 4. 포스트 카드 (`PostCard.astro`)
- **구조:**
  - `rounded-2xl overflow-hidden bg-[var(--card-bg)] border border-[var(--outline-variant)] shadow-sm hover:shadow-xl transition-all duration-300 p-5 sm:p-6 relative group flex flex-col-reverse md:flex-col`
- **Shirone 시그니처 인디케이터:**
  - 제목 좌측 `AccentBar`: `span class="w-1.5 h-5 rounded-full bg-[var(--primary)] shrink-0 inline-block mr-2 -translate-y-0.5"`
  - 제목 호버 시 `var(--primary)` 색상 전환 및 쉐브론 화살표 슬라이드 애니메이션.
- **데스크톱 우측 28% 썸네일 & 줌 오버레이:**
  - 썸네일 보유 시 우측 28% 너비 고정 배치, 마스크 오버레이 및 쉐브론 화살표.
- **썸네일 미보유 시:**
  - M3 Enter Button: `bg-[var(--primary-container)] text-[var(--on-primary-container)] hover:bg-[var(--primary)] hover:text-white rounded-xl`.

---

## 5. 사이드바 (`Sidebar.astro`)
- **프로필 카드:**
  - Shirone 아바타 (`/assets/images/avatar-shirone.webp`) + 활성 상태 도트.
  - 작성자 이름 아래 Shirone 시그니처 언더라인 바 (`h-1 w-6 bg-[var(--primary)] rounded-full`).
  - 통계 바 (포스트 수, 카테고리 수).
  - 🛡️ 100% 공공데이터 기준 검증 뱃지 (상하 14px 균등 여백 보존).
- **카테고리 아코디언:**
  - 모바일 기본 접힘(`hidden`), 데스크톱 항상 펼침(`lg:block`).
  - M3 스타일 카운트 뱃지.

---

## 6. 메인 피드 (`index.astro`)
- Shirone 감성의 웰컴 카드 (로즈 핑크-퍼플 은은한 그라디언트).
- 단정하고 정돈된 최신 포스트 피드.
