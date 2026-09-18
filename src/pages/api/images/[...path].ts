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

export const GET: APIRoute = async ({ params, locals }) => {
  try {
    const bucket = locals.runtime?.env?.BUCKET;
    if (!bucket) {
      return new Response('R2 bucket not configured', { status: 500 });
    }

    const path = params.path;
    if (!path) {
      return new Response('Image path required', { status: 400 });
    }

    // R2에서 images/ prefix로 탐색
    const objectKey = path.startsWith('images/') ? path : `images/${path}`;
    const object = await bucket.get(objectKey);

    if (!object) {
      return new Response(`Image not found: ${objectKey}`, { status: 404 });
    }

    const ext = objectKey.split('.').pop()?.toLowerCase() ?? 'webp';
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    const headers = new Headers();
    try {
      object.writeHttpMetadata(headers);
    } catch (_) {}
    headers.set('Content-Type', contentType);
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    if (object.httpEtag) {
      headers.set('etag', object.httpEtag);
    }

    return new Response(object.body, {
      headers,
    });
  } catch (err: any) {
    return new Response(`Image fetch error: ${err?.message || String(err)}`, { status: 500 });
  }
};
