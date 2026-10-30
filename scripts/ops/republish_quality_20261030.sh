#!/usr/bin/env bash
# 2026-10-30 10/21 이후 자동 발행 글 8편 품질 수정분을 D1에 재발행 (사용자가 직접 실행)
set -uo pipefail
cd "$(dirname "$0")/../.."
export XDG_CONFIG_HOME=/tmp WRANGLER_LOG_PATH=/tmp/wrangler.log PATH="/workspace/.node22/bin:$PATH"
for f in \
  "content/posts/26102101-housing-capital-gains-tax-2026-guide.md" \
  "content/posts/26102201-2026-parental-benefit-eligibility-amount-application-childcare-difference.md" \
  "content/posts/26102301-pension-savings-account-2026-tax-credit-strategy.md" \
  "content/posts/26102401-irp-2026-guide-tax-benefits-investment-strategy.md" \
  "content/posts/26102501-energy-voucher-2026-guide.md" \
  "content/posts/26102601-unemployment-benefits-2026-guide.md" \
  "content/posts/26102801-2026-child-allowance-eligibility-application-guide.md" \
  "content/posts/26102901-gift-tax-filing-deadline-penalties-exemptions-2026.md" \
; do
  echo "== $f"; node scripts/publish-post.mjs "$f" 2>&1 | tail -2
done
