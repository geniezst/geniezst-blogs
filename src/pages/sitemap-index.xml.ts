import type { APIRoute } from 'astro';
import { getDb, getPublishedPosts, getCategories } from '../lib/db';

export const GET: APIRoute = async ({ locals }) => {
  const site = 'https://geniezst.com';
  const db = await getDb(locals);

  let posts: any[] = [];
  let categories: any[] = [];

  if (db) {
    try {
      const [pRes, cRes] = await Promise.all([
        getPublishedPosts(db, { limit: 1000 }),
        getCategories(db),
      ]);
      posts = pRes.posts;
      categories = cRes;
    } catch (e) {
      console.error(e);
    }
  }

  const staticUrls = [
    `${site}/`,
    `${site}/blog`,
    `${site}/about`,
    `${site}/privacy`,
    `${site}/contact`,
  ];

  const urlsXml = [
    ...staticUrls.map(
      (url) => `
    <url>
      <loc>${url}</loc>
      <changefreq>daily</changefreq>
      <priority>0.8</priority>
    </url>`
    ),
    ...categories.map(
      (c) => `
    <url>
      <loc>${site}/category/${c.slug}</loc>
      <changefreq>daily</changefreq>
      <priority>0.7</priority>
    </url>`
    ),
    ...posts.map(
      (p) => `
    <url>
      <loc>${site}/blog/${p.slug}</loc>
      <lastmod>${p.updated_at ? new Date(p.updated_at).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]}</lastmod>
      <changefreq>weekly</changefreq>
      <priority>1.0</priority>
    </url>`
    ),
  ].join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${urlsXml}
</urlset>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
};
