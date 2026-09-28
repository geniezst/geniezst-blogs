-- P1/P2: 대표 이미지 intrinsic 크기 저장
--
-- 배경:
--   image-pipeline.mjs 가 sharp 로 WebP 정규화(최대 폭 1600px)를 수행하며
--   실제 픽셀 크기를 이미 알고 있는데, 이를 DB에 보존하지 않아
--   목록/상세/OG 어디에서도 <img> 에 width/height 를 지정할 수 없었다.
--   결과적으로 이미지가 로드되기 전까지 레이아웃이 0으로 계산되었다가
--   튀는 CLS(누적 레이아웃 이동)가 발생하고, 세로 이미지는
--   고정 종횡비 박스에서 의미 없이 잘려 나왔다.
--
-- image_width / image_height 를 함께 저장하면:
--   1) 목록 카드가 원본 종횡비 그대로를 유지하고
--   2) CLS 없이 space 가 미리 예약되며
--   3) OG 이미지 1200x630 크롭 시 크기 계산 근거가 생긴다.
--
-- 기존 행은 NULL 로 두며, 백필 스크립트가 채운다.
ALTER TABLE blog_posts ADD COLUMN image_width INTEGER;
ALTER TABLE blog_posts ADD COLUMN image_height INTEGER;

-- [P2] OG 표준(1200x630) 크롭본 URL.
--   Workers SSR 런타임에는 sharp 가 없어 요청 시점 OG 크롭이 불가능하므로,
--   image-pipeline.mjs 가 발행 시점에 1200x630 JPEG 를 미리 만들어 R2 에 올리고
--   이 컬럼에 URL 을 저장한다. 소셜 크롤러는 og:image 를 그대로 받는다.
ALTER TABLE blog_posts ADD COLUMN og_image TEXT;
