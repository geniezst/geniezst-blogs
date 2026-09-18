# 스마트 라이프 & 머니 (Smart Life & Money Archive)

대한민국 청년, 직장인, 서민, 소상공인을 위한 **정부 지원금, 숨은 환급금, 스마트 절세 및 생활 금융 가이드** 전문 블로그입니다.

---

## 🏛️ 주요 카테고리

1. **정부 지원금 & 복지 (`welfare`):** 청년도약계좌, 근로·자녀장려금, 부모급여 등 전 국민 정책 금융
2. **연말정산 & 환급/절세 (`tax`):** 숨은 환급금 조회, 소득공제 황금비율, 종합소득세 실전 가이드
3. **예적금 & 금융 꿀팁 (`finance`):** 고금리 파킹통장, 특판 예적금, 청약통장 및 ISA 절세 계좌 활용법
4. **생활비 절약 & 공과금 (`saving`):** 전기·가스요금 캐시백, 통신비 25% 선택약정 할인, 카드 피킹 노하우
5. **소상공인 & 정책자금 (`subsidy`):** 소상공인 전기요금 특별지원, 저금리 대환 대출, 폐업/재창업 지원
6. **생활 행정 & 필수 팁 (`life-tips`):** 정부24 민원 서류 원스톱 발급, 착한운전 마일리지, 일상 행정 상식

---

## 🛠️ 기술 스택 (Tech Stack)

- **Framework:** Astro 7 (SSR)
- **Edge Runtime:** Cloudflare Workers
- **Database:** Cloudflare D1 (`blogs`)
- **Object Storage:** Cloudflare R2 (`blogs`)
- **Styling:** Tailwind CSS + Typography (Fintech Emerald Theme)
- **CI/CD:** GitHub (`main` branch) ➔ Cloudflare Workers 자동 빌드 및 배포

---

## 🚀 로컬 개발 및 운영

```bash
# 개발 서버 실행
npm run dev

# 프로덕션 빌드 검증
npm run build

# D1 원격 마이그레이션
npm run d1:migrate

# 신규 포스트 원격 발행 (CLI)
node scripts/publish-post.mjs content/posts/your-post.md
```
