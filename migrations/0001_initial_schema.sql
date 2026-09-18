-- ==========================================
-- 1. blog_categories (카테고리)
-- ==========================================
CREATE TABLE IF NOT EXISTS blog_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  order_index INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 2. blog_tags (태그)
-- ==========================================
CREATE TABLE IF NOT EXISTS blog_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 3. blog_posts (블로그 글 메타 및 본문)
-- ==========================================
CREATE TABLE IF NOT EXISTS blog_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  content TEXT NOT NULL,
  category_id INTEGER REFERENCES blog_categories(id) ON DELETE SET NULL,
  status TEXT CHECK(status IN ('draft', 'published', 'archived')) DEFAULT 'draft',
  author TEXT DEFAULT 'geniezst',
  featured_image TEXT,
  view_count INTEGER DEFAULT 0,
  reading_time_minutes INTEGER DEFAULT 5,
  canonical_url TEXT,
  meta_keywords TEXT,
  affiliate_disclosure INTEGER DEFAULT 0,
  published_at DATETIME,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 4. blog_post_tags (포스트-태그 N:M)
-- ==========================================
CREATE TABLE IF NOT EXISTS blog_post_tags (
  post_id INTEGER NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES blog_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, tag_id)
);

-- ==========================================
-- 5. 인덱스 정의
-- ==========================================
CREATE INDEX IF NOT EXISTS idx_posts_slug ON blog_posts(slug);
CREATE INDEX IF NOT EXISTS idx_posts_published ON blog_posts(status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_category ON blog_posts(category_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_post_tags_tag ON blog_post_tags(tag_id, post_id);
