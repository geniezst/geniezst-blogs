import { defineMiddleware } from 'astro:middleware';

export const onRequest = defineMiddleware(async (context, next) => {
  const url = new URL(context.request.url);

  // www.pockemoney.com 접속 시 https://pockemoney.com 으로 301 영구 리디렉션 (SEO 표준)
  if (url.hostname === 'www.pockemoney.com') {
    const destination = `https://pockemoney.com${url.pathname}${url.search}`;
    return Response.redirect(destination, 301);
  }

  return next();
});
