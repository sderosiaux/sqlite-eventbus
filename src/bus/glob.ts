/**
 * Simple glob matcher for event type patterns.
 * `*` matches exactly one segment (between dots).
 * Standalone `*` matches everything.
 */
export function matchGlob(pattern: string, eventType: string): boolean {
  // Standalone wildcard matches everything
  if (pattern === '*') return true;

  const patternSegments = pattern.split('.');
  const eventSegments = eventType.split('.');

  if (patternSegments.length !== eventSegments.length) return false;

  for (let i = 0; i < patternSegments.length; i++) {
    if (patternSegments[i] === '*') continue;
    if (patternSegments[i] !== eventSegments[i]) return false;
  }

  return true;
}
