#!/usr/bin/env bash
# 2026-10-19 애드센스 준비: 수정한 금융 글 24편을 D1에 재발행 (사용자가 직접 실행, 사이트 배포 ee564f4 이후)
set -uo pipefail
cd "$(dirname "$0")/../.."
export XDG_CONFIG_HOME=/tmp WRANGLER_LOG_PATH=/tmp/wrangler.log PATH="/workspace/.node22/bin:$PATH"
for f in \
  "content/posts/26091801-youth-leap-account-2026-guide.md" \
  "content/posts/26091802-national-employment-support-allowance-2026.md" \
  "content/posts/26092001-youth-tomorrow-savings-account-2026-guide.md" \
  "content/posts/26092102-credit-debit-card-income-deduction-strategy-2026.md" \
  "content/posts/26092201-isa-maturity-pension-transfer-strategy-2026.md" \
  "content/posts/26092202-hope-savings-account-eligibility-benefits-2026.md" \
  "content/posts/26092301-small-business-policy-funds-guide-2026.md" \
  "content/posts/26092302-health-insurance-dependent-eligibility-guide-2026.md" \
  "content/posts/26092302-sme-worker-preferential-savings-guide-2026.md" \
  "content/posts/26092402-housing-subscription-monthly-limit-250k-strategy-2026.md" \
  "content/posts/26092902-eitc-2026-missed-deadline-remaining-application-windows.md" \
  "content/posts/26093002-housing-pension-2026-guide-maximizing-income.md" \
  "content/posts/26100102-housing-loan-interest-deduction-2026-strategy.md" \
  "content/posts/26100402-newlywed-jeonse-loan-2026-guide.md" \
  "content/posts/26100603-housing-rent-loan-deduction-2026-strategy.md" \
  "content/posts/26100702-youth-monthly-rent-support-2026-guide.md" \
  "content/posts/26100802-credit-card-point-cash-conversion-2026-guide.md" \
  "content/posts/26101002-newlywed-home-loan-2026-guide.md" \
  "content/posts/26101103-housing-benefit-2026-guide-maximizing-support.md" \
  "content/posts/26101202-housing-stability-monthly-rent-loan-2026-guide.md" \
  "content/posts/26101402-youth-jeonse-deposit-guarantee-support-2026.md" \
  "content/posts/26101601-parental-leave-allowance-2026-guide.md" \
  "content/posts/26101701-youth-hope-savings-reinvestment-strategy-2026-new.md" \
  "content/posts/26101801-newborn-special-loan-2026-guide.md" \
; do
  echo "== $f"; node scripts/publish-post.mjs "$f" 2>&1 | tail -2
done
