import { definePublicPaths } from '@/lib/extensions';

/**
 * Extra paths the sign-in wall lets through, each with everything under it.
 * Read by the edge middleware on every request, so keep this file to a list.
 *
 * Already open without adding them here: /api/x/* (each route declares its
 * own auth) and /custom/* (files in public/custom).
 *
 * Example: definePublicPaths(['/book-a-call'])
 */
export default definePublicPaths([]);
