# [사양서] Fumika 공식 테마 디자인 전면 적용 및 고도화 (Authentic Fumika Theme Specification)

- **작성일:** 2026-09-19
- **작성자:** @pm (제품 관리자)
- **적용 대상:** `/workspace/blogs`
- **목표:** 공식 Fumika(`https://github.com/iyanarmanda/fumika`) 테마의 모던 에메랄드/민트 아이덴티티(플로팅 아일랜드 상단바, 히어로 피처드 카드, 에메랄드 뱃지/액센트, 반응형 카테고리 아코디언, 공공데이터 검증 배너)를 100% 충실하게 반영.

---

## 1. 플로팅 아일랜드 상단 내비게이션 바 (Floating Island Navbar)
- **구조:** 화면 상단에서 살짝 떨어진 플로팅 바 (`sticky top-3 sm:top-4 z-50 max-w-6xl mx-auto px-4 sm:px-6`).
- **카드 스타일링:**
  - `card-base rounded-2xl px-4 sm:px-6 h-16 sm:h-[4.25rem] flex items-center justify-between border shadow-lg backdrop-blur-md`
- **브랜드 로고:**
  - 에메랄드 그라디언트 아이콘 (`bg-gradient-to-tr from-emerald-600 to-teal-500 shadow-md shadow-emerald-600/20 group-hover:rotate-6`).
  - 사이트 타이틀 + `Fumika • Smart Money` 서브타이틀.
- **내비게이션 메뉴:**
  - `btn-plain scale-animation px-4 py-2 rounded-xl text-sm font-semibold text-neutral-700 dark:text-neutral-300 hover:text-emerald-600 dark:hover:text-emerald-400`.
- **우측 액션:**
  - 빠른 검색 + 테마 토글.

---

## 2. 히어로 피처드 카드 (Hero Featured Card)
- **최신 1위 가이드 강조 카드:**
  - `card-base overflow-hidden relative group`
  - 상단 1px 그라디언트 라인 (`from-emerald-600 via-teal-500 to-amber-500`).
  - 3대 핵심 혜택 하이라이트 칩.
  - "신청 가이드 확인하기 →" 에메랄드 액션 버튼.
  - 데스크톱(lg)에서 표시, 모바일에서는 간결한 피드 유지.

---

## 3. 포스트 카드 (Fumika PostCard)
- **스타일링:**
  - `card-base p-5 sm:p-6 relative overflow-hidden group hover:-translate-y-1.5 transition-all duration-300`
  - 상단 호버 그라디언트 액센트 라인 (`from-emerald-500 via-teal-400 to-amber-400`).
  - 6대 카테고리별 맞춤형 뱃지 필 (이모지 + 전용 컬러).
  - 썸네일 줌 효과 (`group-hover:scale-105 duration-500`).
  - 하단 "가이드 확인 →" 에메랄드 텍스트 및 호버 슬라이드 애니메이션.

---

## 4. 사이드바 프로필 & 카테고리
- **프로필 카드:**
  - 모바일에서는 아바타/이름 숨김 (`hidden lg:block`), 데스크톱에서만 표시.
  - 통계 수치 바 (포스트 수 정확 반영).
  - 🛡️ 100% 공공데이터 기준 검증 뱃지 (상하 여백 14px 균등 유지).
- **카테고리 아코디언:**
  - 모바일 기본 접힘(`hidden`), 클릭 시 토글.
  - 데스크톱 항상 펼침 (`lg:block`).
  - 카테고리별 컬러 도트 및 카운트 뱃지.

---

## 5. 인수인계
- `@frontend`는 상기 사양에 맞춰 `blogs`의 모든 컴포넌트 디자인을 검증 및 확정할 것.
- 빌드 검증 후 `@qa`에게 코드 감사를 요청할 것.
