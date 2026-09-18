import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ locals }) => {
  let hasDB = false;
  let hasBucket = false;

  try {
    const cf = await import('cloudflare:workers');
    hasDB = !!cf.env?.DB;
    hasBucket = !!cf.env?.BUCKET;
  } catch {
    hasDB = !!(locals as any)?.runtime?.env?.DB;
    hasBucket = !!(locals as any)?.runtime?.env?.BUCKET;
  }

  return new Response(
    JSON.stringify({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      bindings: {
        d1: hasDB,
        r2: hasBucket,
      },
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    }
  );
};
