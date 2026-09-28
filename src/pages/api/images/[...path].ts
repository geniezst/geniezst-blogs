import type { APIRoute } from 'astro';

const MIME_TYPES: Record<string, string> = {
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  avif: 'image/avif',
};

const FALLBACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="이미지를 불러올 수 없습니다">
  <rect width="1200" height="630" fill="#1c1917"/>
  <text x="600" y="315" fill="#a8a29e" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="34" text-anchor="middle">이미지를 불러올 수 없습니다</text>
  <text x="600" y="368" fill="#78716c" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="22" text-anchor="middle">포켓머니</text>
</svg>`;

async function getBucket(locals?: any) {
  try {
    const cf = await import('cloudflare:workers');
    if ((cf.env as any)?.BUCKET) {
      return (cf.env as any).BUCKET;
    }
  } catch {}

  try {
    if (locals?.runtime?.env?.BUCKET) {
      return locals.runtime.env.BUCKET;
    }
  } catch {}

  return null;
}

type Ctx = Parameters<NonNullable<APIRoute>>[0];

async function serve(request: Request, ctx: Ctx): Promise<Response> {
  const { params, locals } = ctx;

  const bucket = await getBucket(locals);
  if (!bucket) {
    return new Response('R2 bucket not configured', { status: 500 });
  }

  const path = params.path;
  if (!path) {
    return new Response('Image path required', { status: 400 });
  }

  // R2에서 images/ prefix로 탐색
  const objectKey = path.startsWith('images/') ? path : `images/${path}`;
  const isHead = request.method === 'HEAD';

  let object: R2ObjectBody | null = null;
  try {
    object = await bucket.get(objectKey);
  } catch (_) {
    object = null;
  }

  if (!object) {
    // [P1-3] 404 응답 바디에 오류 문자열을 그대로 노출하지 않는다.
    // img 태그는 404 본문을 "이미지"로 렌더링하거나 레이아웃을 깨뜨리므로,
    // 명시적 HEAD 요청에는 404 상태만, GET 요청에는 placeholder SVG 를 돌려준다.
    if (isHead) {
      return new Response(null, { status: 404, headers: { 'Cache-Control': 'public, max-age=60' } });
    }
    return new Response(FALLBACK_SVG, {
      status: 404,
      headers: {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      },
    });
  }

  const ext = objectKey.split('.').pop()?.toLowerCase() ?? 'webp';
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  const headers = new Headers();
  try {
    object.writeHttpMetadata(headers);
  } catch (_) {}
  headers.set('Content-Type', contentType);
  // [P1-3] 콘텐츠 해시가 키에 포함된 불변 이미지다. 1년 immutable 캐시가 정당하다.
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('X-Content-Type-Options', 'nosniff');
  if (object.httpEtag) {
    headers.set('etag', object.httpEtag);
  }

  if (isHead) {
    // [P1-3] HEAD 는 본문을 읽지 않고 메타데이터만 반환해야
    // 브라우저 이미지 프리로더가 불필요한 대역폭을 소모하지 않는다.
    if (object.size != null) {
      headers.set('Content-Length', String(object.size));
    }
    return new Response(null, { status: 200, headers });
  }

  return new Response(object.body, { headers });
}

export const GET: APIRoute = async (ctx) => serve(ctx.request, ctx);
export const HEAD: APIRoute = async (ctx) => serve(ctx.request, ctx);
