import { defineMiddleware } from 'astro:middleware';

const CANONICAL_ORIGIN = 'https://pockemoney.com';

// 중복·기준 연도가 지난 글 통합에 따른 301 영구 리디렉션 (docs/SPEC_ADSENSE_PREEMPTIVE_REMEDIATION.md P0-2)
// 팩트체크로 비공개 처리 후 재작성 중인 글(청년도약계좌·청년내일저축계좌·주택연금·주담대 공제)로 향하는 통합 리디렉션은
// 대상 글이 다시 공개될 때 추가한다. (영구 리디렉션이 404 로 향하지 않도록)
const REDIRECTS: Record<string, string> = {
  '/blog/year-end-tax-refund-maximization-2024': '/blog/credit-debit-card-income-deduction-strategy-2026',
};

export const onRequest = defineMiddleware(async (context, next) => {
  const url = new URL(context.request.url);
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

  // 영구 삭제된 뉴스 다이제스트(숫자 접두사 slug)와 새소식 카테고리는 410 Gone 으로 응답해 색인 제거를 앞당긴다.
  if (/^\/blog\/\d{8}-/.test(pathname) || pathname === '/category/news') {
    return new Response('410 Gone', { status: 410, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': 'noindex' } });
  }

  const redirectTarget = REDIRECTS[pathname];
  if (redirectTarget) {
    return Response.redirect(`${CANONICAL_ORIGIN}${redirectTarget}`, 301);
  }

  // http 요청 및 www.pockemoney.com 접속 시 https://pockemoney.com 으로 301 영구 리디렉션 (SEO 표준)
  // 로컬 개발 서버(localhost)는 제외한다.
  const isProdHost = url.hostname === 'pockemoney.com';
  const isAliasHost = url.hostname === 'www.pockemoney.com';
  if (isAliasHost || (isProdHost && url.protocol === 'http:')) {
    return Response.redirect(`${CANONICAL_ORIGIN}${url.pathname}${url.search}`, 301);
  }

  return next();
});
