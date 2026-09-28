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
  /**
   * 대표 이미지의 정규화 후 픽셀 크기.
   * image-pipeline.mjs 가 sharp 로 정규화하며 계산하고 publish-post 가 저장한다.
   * <img> 의 width/height 속성으로 사용해 CLS 를 방지한다.
   */
  image_width?: number | null;
  image_height?: number | null;
  /**
   * [P2] OG 표준(1200x630) 로 미리 크롭된 이미지 URL.
   * Workers 런타임에 sharp 가 없어 발행 시점에 생성해 R2 에 올린 뒤 여기 저장한다.
   */
  og_image?: string | null;
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
