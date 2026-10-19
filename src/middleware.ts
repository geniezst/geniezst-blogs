import { defineMiddleware } from 'astro:middleware';

const CANONICAL_ORIGIN = 'https://pockemoney.com';

// 중복·기준 연도가 지난 글 통합에 따른 301 영구 리디렉션 (docs/SPEC_ADSENSE_PREEMPTIVE_REMEDIATION.md)
// 대상 글은 팩트체크 후 재작성·재공개된 대표 글이다.
const REDIRECTS: Record<string, string> = {
  // 청년도약계좌(신규가입 종료) 관련 글 → 기존 가입자 + 청년미래적금 대표 글
  '/blog/youth-leap-account-tax-exemption-guide': '/blog/youth-leap-account-2026-guide',
  '/blog/youth-leap-account-maturity-return-simulation-2026': '/blog/youth-leap-account-2026-guide',
  '/blog/youth-leap-account-saving-contribution-strategy-2026': '/blog/youth-leap-account-2026-guide',
  '/blog/youth-leap-account-early-termination-tips-2026': '/blog/youth-leap-account-2026-guide',
  '/blog/youth-leap-account-welfare-benefits-2026': '/blog/youth-leap-account-2026-guide',
  '/blog/youth-jump-account-2026-guide': '/blog/youth-leap-account-2026-guide',
  '/blog/youth-hope-savings-reinvestment-strategy-2026': '/blog/youth-leap-account-2026-guide',
  // 청년내일저축계좌
  '/blog/youth-tomorrow-savings-account-2026-third-application-guide': '/blog/youth-tomorrow-savings-account-2026-guide',
  '/blog/youth-savings-plus-account-2026-guide': '/blog/youth-tomorrow-savings-account-2026-guide',
  // 주택연금·주담대 공제
  '/blog/housing-pension-pre-booking-2026-strategy': '/blog/housing-pension-2026-guide-maximizing-income',
  '/blog/housing-loan-refinancing-tax-deduction-2026': '/blog/housing-loan-interest-deduction-2026-strategy',
  // 기준 연도가 지난 글
  '/blog/year-end-tax-refund-maximization-2024': '/blog/credit-debit-card-income-deduction-strategy-2026',
};

const ALIAS_HOSTS = new Set(['www.pockemoney.com']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

export const onRequest = defineMiddleware(async (context, next) => {
  const url = new URL(context.request.url);
  const method = context.request.method;
  // 끝 슬래시 제거(루트 제외). 정규화 경로는 410·통합 slug 판정과 최종 리디렉션 대상에 함께 쓴다.
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') || '/' : url.pathname;

  // 영구 삭제된 뉴스 다이제스트(숫자 접두사 slug)와 새소식 카테고리는 410 Gone 으로 응답해 색인 제거를 앞당긴다.
  if (/^\/blog\/\d{8}-/.test(pathname) || pathname === '/category/news') {
    return new Response('410 Gone', { status: 410, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': 'noindex' } });
  }

  // POST 등 API 요청은 리디렉션하면 메서드가 바뀔 수 있으므로 GET/HEAD 만 정규화한다.
  if (method !== 'GET' && method !== 'HEAD') {
    return next();
  }

  const host = url.hostname.toLowerCase();
  const isLocal = LOCAL_HOSTS.has(host);
  // www·workers.dev·http 접속은 https://pockemoney.com 으로 통일한다 (docs/SPEC_ADSENSE_REAPPLY_FIXES.md ## 플랫폼).
  const needsOrigin =
    !isLocal &&
    (ALIAS_HOSTS.has(host) || host.endsWith('.workers.dev') || (host === 'pockemoney.com' && url.protocol === 'http:'));
  const origin = isLocal ? url.origin : CANONICAL_ORIGIN;

  // 통합 slug, 호스트·프로토콜, 끝 슬래시를 한 번에 계산해 단일 301 로 최종 URL 에 보낸다 (다중 리디렉션 방지).
  const redirectTarget = REDIRECTS[pathname];
  const targetPath = redirectTarget ?? pathname;
  if (redirectTarget || needsOrigin || targetPath !== url.pathname) {
    return new Response(null, {
      status: 301,
      headers: { Location: `${origin}${targetPath}${url.search}`, 'Cache-Control': 'public, max-age=3600' },
    });
  }

  return next();
});
