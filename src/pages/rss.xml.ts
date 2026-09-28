import type { APIRoute } from 'astro';
import { getDb, getPublishedPosts } from '../lib/db';

const site = 'https://pockemoney.com';

/** XML 특수문자 이스케이프 (title/description CDATA 내부라도 안전하게) */
const xmlEsc = (s: string) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/** 상대 경로를 절대 URL 로. 외부 URL 은 그대로 통과 */
const abs = (u: string | null | undefined): string | null => {
  if (!u) return null;
  if (u.startsWith('http')) return u;
  return `${site}${u.startsWith('/') ? '' : '/'}${u}`;
};

const MIME_BY_EXT: Record<string, string> = {
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  avif: 'image/avif',
};

const mimeOf = (u: string) => MIME_BY_EXT[(u.split('.').pop() || '').toLowerCase()] || 'image/jpeg';

export const GET: APIRoute = async ({ locals }) => {
  const db = await getDb(locals);
  let posts: any[] = [];
  if (db) {
    try {
      const res = await getPublishedPosts(db, { limit: 20 });
      posts = res.posts;
    } catch (e) {
      console.error(e);
    }
  }

  /*
    [P2] RSS 이미지 노출
      기존엔 <enclosure> 도 <media:content> 도 없었어, RSS 리더(네이버/구글/Feedly)에서
      대표 이미지가 전혀 뜨지 않았다. enclosure + media:content + media:thumbnail 를 넣고,
      RSS 2.0 은 확장 네임스페이스가 필요하므로 함께 선언한다.
      og_image(1200x630) 를 쓸 수 있으면 그걸, 없으면 featured_image 를 쓴다.
  */
  const items = posts
    .map((p) => {
      const featured = abs(p.featured_image);
      const og = abs(p.og_image);
      const primary = og || featured;
      const thumb = featured || og;

      const media = [
        primary
          ? `      <media:content url="${xmlEsc(primary)}" medium="image" type="${xmlEsc(mimeOf(primary!))}"${
              p.image_width && og ? ` width="${Number(p.image_width)}" height="${Number(p.image_height || 630)}"` : ''
            } />`
          : '',
        thumb ? `      <media:thumbnail url="${xmlEsc(thumb)}" />` : '',
      ]
        .filter(Boolean)
        .join('\n');

      const enclosure = primary
        ? `      <enclosure url="${xmlEsc(primary)}" type="${xmlEsc(mimeOf(primary))}" length="0" />`
        : '';

      return `
    <item>
      <title><![CDATA[${p.title}]]></title>
      <link>${site}/blog/${p.slug}</link>
      <guid isPermaLink="true">${site}/blog/${p.slug}</guid>
      <description><![CDATA[${p.description}]]></description>
      <pubDate>${p.published_at ? new Date(p.published_at).toUTCString() : new Date().toUTCString()}</pubDate>
${enclosure}${enclosure ? '\n' : ''}${media}${media ? '\n' : ''}    </item>`;
    })
    .join('');

  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>포켓머니 (pockemoney)</title>
    <link>${site}</link>
    <description>놓치면 손해보는 정부 지원금, 숨은 환급금, 생활 절세 및 스마트 소비 실전 가이드</description>
    <language>ko</language>
    <atom:link href="${site}/rss.xml" rel="self" type="application/rss+xml"/>
    ${items}
  </channel>
</rss>`;

  return new Response(rss, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
