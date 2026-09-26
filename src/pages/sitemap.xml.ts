import type { APIRoute } from 'astro';
import { GET as getSitemap } from './sitemap-index.xml';

export const GET: APIRoute = getSitemap;
