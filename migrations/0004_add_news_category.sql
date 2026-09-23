-- 0004_add_news_category.sql
-- 새소식 (news) 카테고리 신설: 다이제스트 전용 카테고리
INSERT OR IGNORE INTO blog_categories (slug, name, description, order_index)
VALUES ('news', '새소식', '오늘 아침 꼭 알아야 할 주요 정부 정책 및 생활 금융 핫이슈 브리핑', 0);

-- 기존 발행된 다이제스트 포스트의 category_id를 news로 일괄 업데이트
UPDATE blog_posts 
SET category_id = (SELECT id FROM blog_categories WHERE slug = 'news' LIMIT 1)
WHERE slug LIKE '%-morning-%' OR slug LIKE '%-digest-%';
