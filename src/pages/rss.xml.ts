import type { APIRoute } from 'astro';
import { getDb, getPublishedPosts } from '../lib/db';

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

  const site = 'https://geniezst.com';
  const items = posts
    .map(
      (p) => `
    <item>
      <title><![CDATA[${p.title}]]></title>
      <link>${site}/blog/${p.slug}</link>
      <guid>${site}/blog/${p.slug}</guid>
      <description><![CDATA[${p.description}]]></description>
      <pubDate>${p.published_at ? new Date(p.published_at).toUTCString() : new Date().toUTCString()}</pubDate>
    </item>`
    )
    .join('');

  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>geniezst</title>
    <link>${site}</link>
    <description>실제 경험과 문제 해결을 위한 IT &amp; AI 테크 블로그</description>
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
