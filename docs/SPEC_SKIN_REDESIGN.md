# blogs 신규 스킨 디자인 사양서 (Skin Redesign Specification)

- **작성일:** 2026-09-18
- **작성자:** @pm (제품 관리자)
- **적용 대상:** `/workspace/blogs` (스마트 라이프 & 머니)
- **스킨 명칭:** **Fintech Emerald & Editorial Magazine (핀테크 에메랄드 에디토리얼)**

---

## 1. 디자인 개편 배경 및 목표

1호 블로그(`/workspace/blog`)는 어두운 톤과 모노스페이스 중심의 개발자/엔지니어링 테크 감성을 지니고 있습니다.
반면 2호 블로그(`/workspace/blogs`)는 일반 직장인, 주부, 청년, 소상공인을 대상으로 **정부 지원금, 환급금, 예적금, 생활비 절약** 정보를 전달하므로, 토스(Toss), 네이버페이, 카카오뱅크, 블룸버그/너드월렛과 같은 **"신뢰감, 가독성, 산뜻함"**을 극대화한 독자적인 핀테크 에디토리얼 스킨이 필요합니다.

### 핵심 디자인 목표
1. **시각적 정체성 차별화:** 1호 블로그의 블루/바이올렛 계열에서 완전히 탈피하여, 신뢰와 자산 성장을 상징하는 **에메랄드 그린(Emerald) & 슬레이트 네이비(Slate Navy)**를 메인 컬러로 채택.
2. **카테고리 직관성 강화:** 6대 카테고리(`welfare`, `tax`, `finance`, `saving`, `subsidy`, `life-tips`)별로 고유한 파스텔 뱃지 색상을 부여하여 탐색성 극대화.
3. **독자 친화적 히어로 섹션:** 상단에 정부 정책 및 절세 금융 혜택을 한눈에 볼 수 있는 매거진형 웰컴 배너 및 카테고리 퀵 필터 칩 배치.
4. **본문 가독성(Typography) 고도화:** 정부 요건표(Table)에 에메랄드 헤더 스타일을 적용하고, 핵심 체크포인트를 강조하는 요약 박스 디자인 추가.

---

## 2. 디자인 토큰 및 컬러 시스템

| 토큰 | 라이트 모드 (Light) | 다크 모드 (Dark) | 용도 |
|---|---|---|---|
| `--color-primary` | `#059669` (Emerald 600) | `#10B981` (Emerald 500) | 브랜드 포인트, 버튼, 링크, H2 바 |
| `--color-primary-hover` | `#047857` (Emerald 700) | `#34D399` (Emerald 400) | 인터랙션 호버 상태 |
| `--bg-page` | `#F8FAFC` (Slate 50) | `#0B131F` (Deep Midnight) | 전체 배경색 |
| `--bg-card` | `rgba(255, 255, 255, 0.95)` | `rgba(17, 28, 45, 0.9)` | 카드 컨테이너 배경 |
| `--border-card` | `rgba(226, 232, 240, 0.9)` | `rgba(30, 48, 77, 0.7)` | 카드 경계선 |
| `--card-shadow-hover` | `0 12px 28px -4px rgba(5, 150, 105, 0.12)` | `0 12px 32px -4px rgba(0, 0, 0, 0.6)` | 카드 호버 그림자 |

---

## 3. 6대 카테고리 전용 뱃지 스타일 규격

| 카테고리 | slug | 뱃지 배경/텍스트 | 아이콘 |
|---|---|---|---|
| **정부 지원금 & 복지** | `welfare` | `bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300` | 🏛️ |
| **연말정산 & 환급/절세** | `tax` | `bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300` | 💰 |
| **예적금 & 금융 꿀팁** | `finance` | `bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300` | 📈 |
| **생활비 절약 & 공과금** | `saving` | `bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300` | ⚡ |
| **소상공인 & 정책자금** | `subsidy` | `bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300` | 🏪 |
| **생활 행정 & 필수 팁** | `life-tips` | `bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300` | 📋 |

---

## 4. 컴포넌트별 개편 명세

1. **`src/styles/global.css` & `src/styles/article.css`:**
   - 블루 색상 변수를 에메랄드/민트/슬레이트 기반으로 교체
   - 글래스모피즘 카드(`fuwari-card`) 테두리 및 호버 효과 에메랄드 틴트 적용
   - 본문 H2 좌측 포인트 바를 `border-emerald-500`으로 변경
   - 마크다운 테이블 헤더에 에메랄드 틴트(`bg-emerald-50/70 dark:bg-emerald-950/40`) 적용

2. **`src/components/Header.astro`:**
   - 로고 아바타 그라데이션: `from-emerald-500 to-teal-600`
   - 금융 성장/스마트 지갑 아이콘 심볼 적용
   - 내비게이션 및 검색 호버 상태 에메랄드 틴트 적용

3. **`src/components/Sidebar.astro`:**
   - 아바타 심볼 및 배지: 에메랄드 & 엠버 그라데이션
   - 프로필 소개: "스마트 머니 편집부"
   - 사이드바 카테고리 목록: 카테고리별 고유 색상 점(Dot) 노출
   - 사이드바 하단: "💡 놓치기 쉬운 필수 정부 혜택 상시 안내" 미니 배너 추가

4. **`src/components/PostCard.astro`:**
   - 6대 카테고리별 동적 뱃지 컬러링 적용
   - 카드 호버 시 상단 에메랄드 미세 하이라이트 라인
   - "신청 가이드 확인하기 →" 액션 버튼

5. **`src/pages/index.astro`:**
   - 생활 경제 전용 웰컴 히어로 배너 (에메랄드/틸 그라데이션 + 3대 안심 포인트)
   - 카테고리 즉시 필터링용 퀵 칩(Quick Filter Chips) 영역 신설
   - 타이틀/디스크립션 "스마트 라이프 & 머니" 일치화

6. **`src/pages/blog/[slug].astro`:**
   - 본문 상단 핵심 요약 배너 박스 레이아웃 지원
   - 뒤로가기 버튼 및 태그 칩 에메랄드 스타일 통일
