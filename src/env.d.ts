/// <reference path="../.astro/types.d.ts" />

type D1Database = import('@cloudflare/workers-types').D1Database;
type R2Bucket = import('@cloudflare/workers-types').R2Bucket;

interface CloudflareEnv {
  DB: D1Database;
  BUCKET: R2Bucket;
}

declare namespace App {
  interface Locals {
    runtime: {
      env: CloudflareEnv;
      cf?: import('@cloudflare/workers-types').IncomingRequestCfProperties;
      ctx?: import('@cloudflare/workers-types').ExecutionContext;
      caches?: import('@cloudflare/workers-types').CacheStorage;
    };
  }
}
