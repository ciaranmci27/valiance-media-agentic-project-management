/**
 * Where releases come from, and which one this install runs.
 *
 * Releases are vX.Y.Z tags on the public repo. An install keeps that repo's
 * history and merges each tag (npm run upgrade), so its own code lives only in
 * client-owned paths (src/custom and friends) and never conflicts.
 */
import packageJson from '../../../package.json';

/** owner/name of the public repository releases are published to. */
export const UPSTREAM_REPO = 'ciaranmci27/valiance-media-agentic-project-management';

/** The git remote URL an install fetches release tags from (remote name: upstream). */
export const UPSTREAM_URL = `https://github.com/${UPSTREAM_REPO}.git`;

/** The version this build runs: package.json's version, which each release sets. */
export function currentVersion(): string {
  return packageJson.version;
}
