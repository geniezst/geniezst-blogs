import type { D1Database } from '@cloudflare/workers-types';
import type { BlogPost, Category, Tag } from '../types/blog';

async function getCloudflareEnv() {
  try {
    const cf = await import('cloudflare:workers');
    return cf.env as { DB?: D1Database; BUCKET?: any };
  } catch {
    return null;
  }
}

export async function getDb(locals?: any): Promise<D1Database | null> {
  const cfEnv = await getCloudflareEnv();
  if (cfEnv?.DB) return cfEnv.DB;

  try {
    if (locals?.runtime?.env?.DB) return locals.runtime.env.DB;
  } catch {
    // runtime.env getter throws in newer astro-cloudflare
  }

  return null;
}

export async function getCategories(db: D1Database): Promise<Category[]> {
  try {
    const { results } = await db
      .prepare(
        `SELECT c.*, (
          SELECT COUNT(*) FROM blog_posts p 
          WHERE p.category_id = c.id AND p.status = 'published'
        ) as post_count
        FROM blog_categories c 
        ORDER BY c.order_index ASC`
      )
      .all<Category>();
    return results ?? [];
  } catch (err) {
    console.error('getCategories error:', err);
    return [];
  }
}

export async function getTotalPublishedPosts(db: D1Database): Promise<number> {
  try {
    const res = await db
      .prepare("SELECT COUNT(*) as count FROM blog_posts WHERE status = 'published'")
      .first<{ count: number }>();
    return res?.count ?? 0;
  } catch (err) {
    console.error('getTotalPublishedPosts error:', err);
    return 0;
  }
}

export async function getPublishedPosts(
  db: D1Database,
  options: { limit?: number; offset?: number; categorySlug?: string } = {}
): Promise<{ posts: BlogPost[]; total: number }> {
  try {
    const { limit = 10, offset = 0, categorySlug } = options;

    let query = `
      SELECT p.*, c.name as category_name, c.slug as category_slug
      FROM blog_posts p
      LEFT JOIN blog_categories c ON p.category_id = c.id
      WHERE p.status = 'published'
    `;
    const params: any[] = [];

    if (categorySlug) {
      query += ` AND c.slug = ?`;
      params.push(categorySlug);
    }

    query += ` ORDER BY p.published_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const postsStmt = db.prepare(query).bind(...params);
    const { results: posts } = await postsStmt.all<BlogPost>();

    let countQuery = `
      SELECT COUNT(*) as count
      FROM blog_posts p
      LEFT JOIN blog_categories c ON p.category_id = c.id
      WHERE p.status = 'published'
    `;
    const countParams: any[] = [];
    if (categorySlug) {
      countQuery += ` AND c.slug = ?`;
      countParams.push(categorySlug);
    }
    const countRes = await db.prepare(countQuery).bind(...countParams).first<{ count: number }>();
    const total = countRes?.count ?? 0;

    return { posts: posts ?? [], total };
  } catch (err) {
    console.error('getPublishedPosts error:', err);
    return { posts: [], total: 0 };
  }
}

export async function getPostBySlug(db: D1Database, slug: string): Promise<BlogPost | null> {
  try {
    const post = await db
      .prepare(
        `SELECT p.*, c.name as category_name, c.slug as category_slug
         FROM blog_posts p
         LEFT JOIN blog_categories c ON p.category_id = c.id
         WHERE p.slug = ? AND p.status = 'published'
         LIMIT 1`
      )
      .bind(slug)
      .first<BlogPost>();

    if (!post) return null;

    const { results: tags } = await db
      .prepare(
        `SELECT t.* FROM blog_tags t
         INNER JOIN blog_post_tags pt ON t.id = pt.tag_id
         WHERE pt.post_id = ?`
      )
      .bind(post.id)
      .all<Tag>();

    post.tags = tags ?? [];
    return post;
  } catch (err) {
    console.error('getPostBySlug error:', err);
    return null;
  }
}

export async function incrementPostViews(db: D1Database, id: number): Promise<void> {
  try {
    await db
      .prepare('UPDATE blog_posts SET view_count = view_count + 1 WHERE id = ?')
      .bind(id)
      .run();
  } catch (err) {
    console.error('incrementPostViews error:', err);
  }
}
