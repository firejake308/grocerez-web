/**
 * CORS origin matching. Beyond the exact-match list from CORS_ORIGINS, also
 * accepts Netlify deploy-preview and branch-deploy URLs for a configured
 * site, since Netlify mints a new subdomain for every one of those and a
 * fixed list can never enumerate them (e.g.
 * https://deploy-preview-123--<slug>.netlify.app,
 * https://<branch-slug>--<slug>.netlify.app).
 */

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Builds a Hono `cors({ origin })` matcher function. `netlifySiteSlug` empty
 * disables preview matching entirely, so only `corsOrigins` are ever
 * allowed -- same "empty config = feature off" pattern as the rest of the
 * app's optional integrations.
 */
export function buildCorsOriginMatcher(corsOrigins: string[], netlifySiteSlug: string): (origin: string) => string | null {
  const previewPattern = netlifySiteSlug
    ? new RegExp(`^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?--${escapeRegExp(netlifySiteSlug)}\\.netlify\\.app$`)
    : null;

  return (origin: string): string | null => {
    if (corsOrigins.includes(origin)) return origin;
    if (previewPattern && previewPattern.test(origin)) return origin;
    return null;
  };
}
