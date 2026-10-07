import type { APIRoute } from 'astro';

export const GET: APIRoute = () => {
  const adsTxt = `google.com, pub-9338927727391440, DIRECT, f08c47fec0942fa0\n`;

  return new Response(adsTxt, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
