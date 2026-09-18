export interface Category {
  id: number;
  slug: string;
  name: string;
  description?: string;
  order_index: number;
  post_count?: number;
  created_at: string;
}

export interface Tag {
  id: number;
  slug: string;
  name: string;
  created_at: string;
}

export interface BlogPost {
  id: number;
  slug: string;
  title: string;
  description: string;
  content: string;
  category_id: number | null;
  category_name?: string;
  category_slug?: string;
  status: 'draft' | 'published' | 'archived';
  author: string;
  featured_image?: string | null;
  view_count: number;
  reading_time_minutes: number;
  canonical_url?: string | null;
  meta_keywords?: string | null;
  affiliate_disclosure: number;
  published_at: string | null;
  updated_at: string;
  created_at: string;
  tags?: Tag[];
}
