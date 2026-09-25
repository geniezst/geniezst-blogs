import type { APIRoute } from 'astro';

export const GET: APIRoute = () => {
  return new Response('6059e7c7aa31475986bb3547ace2c153', {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
};
