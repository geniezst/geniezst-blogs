# 기술 사양서: blogs 초록 계열 원래 주제색상(Financial Emerald / Mint) 복원

## 1. 개요
* **목표:** `blogs`의 테마 색상을 기존의 로즈/핑크(Rose/Pink M3) 팔레트에서 원래의 고유 주제색상이었던 **초록 계열(Financial Emerald & Mint)**로 전면 복원
* **적용 대상:** `/workspace/blogs`
* **담당:** `@pm` (사양 정의) $\rightarrow$ `@frontend` (CSS 및 UI 컴포넌트 색상 수정) $\rightarrow$ `@qa` (빌드 검증 및 최종 승인)

---

## 2. 컬러 팔레트 사양 정의 (Design Tokens)

### 2.1 라이트 모드 (Light Mode)
* **주요 콘셉트:** 신뢰감 있는 금융 에메랄드 (Financial Emerald) & 테일 (Teal)
* `--bg-page`: `#f8fafc` (기존 은은한 슬레이트/클린 화이트)
* `--card-bg`: `#ffffff`
* `--card-bg-subtle`: `#f1f5f9`
* `--surface`: `#f8fafc`
* `--surface-container-lowest`: `#ffffff`
* `--surface-container-low`: `#f1f5f9`
* `--surface-container`: `#e2e8f0`
* `--surface-container-high`: `#cbd5e1`
* `--surface-container-highest`: `#94a3b8`
* `--on-surface`: `#0f172a`
* `--on-surface-variant`: `#475569`
* `--outline`: `#64748b`
* `--outline-variant`: `rgba(100, 116, 139, 0.18)`
* **Primary (주요 색상):** `#059669` (Financial Emerald / Emerald 600)
  * `--primary-rgb`: `5, 150, 105`
  * `--primary-hover`: `#047857` (Emerald 700)
  * `--on-primary`: `#ffffff`
  * `--primary-container`: `#d1fae5` (Emerald 100)
  * `--on-primary-container`: `#064e3b` (Emerald 900)
  * `--primary-light`: `#ecfdf5` (Emerald 50)
* **Secondary (보조 색상):** `#0d9488` (Teal 600)
  * `--secondary-container`: `#ccfbf1` (Teal 100)
  * `--on-secondary-container`: `#134e4a` (Teal 900)
* **Tertiary (강조 색상):** `#d97706` (Financial Amber / Gold)
  * `--tertiary-container`: `#fef3c7`
* **그림자 및 상호작용:**
  * `--card-shadow`: `0 1px 3px 0 rgba(0, 0, 0, 0.04), 0 1px 2px -1px rgba(0, 0, 0, 0.04)`
  * `--card-shadow-hover`: `0 8px 24px -4px rgba(5, 150, 105, 0.16), 0 2px 6px -1px rgba(0, 0, 0, 0.04)`
  * `--btn-plain-bg-hover`: `rgba(5, 150, 105, 0.08)`
  * `--btn-plain-bg-active`: `rgba(5, 150, 105, 0.16)`

### 2.2 다크 모드 (Dark Mode)
* **주요 콘셉트:** 시인성 높은 민트 에메랄드 (Mint Emerald) & 딥 네이비/슬레이트 서페이스
* `--bg-page`: `#0a101d`
* `--card-bg`: `#101a2c`
* `--card-bg-subtle`: `#121e33`
* `--surface`: `#0a101d`
* `--surface-container-lowest`: `#070c16`
* `--surface-container-low`: `#0f1726`
* `--surface-container`: `#162338`
* `--surface-container-high`: `#1e2f4a`
* `--surface-container-highest`: `#283d5f`
* `--on-surface`: `#f8fafc`
* `--on-surface-variant`: `#cbd5e1`
* `--outline`: `#64748b`
* `--outline-variant`: `rgba(100, 116, 139, 0.22)`
* **Primary (주요 색상):** `#10b981` (Mint Emerald / Emerald 500)
  * `--primary-rgb`: `16, 185, 129`
  * `--primary-hover`: `#34d399` (Emerald 400)
  * `--on-primary`: `#064e3b` (Emerald 900)
  * `--primary-container`: `#065f46` (Emerald 800)
  * `--on-primary-container`: `#a7f3d0` (Emerald 200)
  * `--primary-light`: `rgba(16, 185, 129, 0.14)`
* **Secondary (보조 색상):** `#2dd4bf` (Teal 400)
  * `--secondary-container`: `#115e59`
  * `--on-secondary-container`: `#ccfbf1`
* **Tertiary (강조 색상):** `#fbbf24` (Amber 400)
  * `--tertiary-container`: `#78350f`
* **그림자 및 상호작용:**
  * `--card-shadow`: `0 2px 8px 0 rgba(0, 0, 0, 0.35)`
  * `--card-shadow-hover`: `0 8px 28px -4px rgba(16, 185, 129, 0.2)`
  * `--btn-plain-bg-hover`: `rgba(16, 185, 129, 0.12)`
  * `--btn-plain-bg-active`: `rgba(16, 185, 129, 0.22)`

---

## 3. 수정 대상 파일 및 변경 사항

1. `src/styles/global.css`:
   - 루트 및 다크 모드 토큰을 초록 계열(Emerald/Teal)로 전면 교체
2. `src/components/HeroFeatured.astro`:
   - 잔여 핑크 그라디언트 및 뱃지(`from-pink-600`, `bg-pink-50`, `text-pink-800`, `shadow-pink-600`)를 에메랄드/테일(`from-emerald-600 via-teal-500 to-emerald-400`, `bg-emerald-50`, `text-emerald-800`, `shadow-emerald-600`)로 수정
3. `src/pages/blog/[slug].astro`:
   - 상세 페이지 잔여 핑크/로즈 클래스(`hover:bg-pink-50`, `from-pink-600`, `from-pink-500/10`, `border-pink-200`, `bg-pink-50` 등)를 에메랄드/테일로 수정
