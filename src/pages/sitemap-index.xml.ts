import type { APIRoute } from 'astro';

// 사이트맵 인덱스: 실제 URL 목록은 /sitemap.xml(urlset) 하나에만 둔다.
// 과거 두 경로가 같은 urlset 을 중복 반환하던 것을 정리했다 (docs/SPEC_ADSENSE_REAPPLY_FIXES.md ## 플랫폼).
export const GET: APIRoute = () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://pockemoney.com/sitemap.xml</loc>
  </sitemap>
</sitemapindex>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
};
