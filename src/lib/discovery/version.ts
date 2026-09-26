/**
 * The version every discovery document in this directory advertises.
 *
 * A SECOND `x-release-please-version` marker, deliberately. The first is
 * workers/mcp/src/server.ts:126, whose own comment says that moving the
 * version off that line strands it silently -- so this file does not move it.
 * release-please's `generic` updater rewrites the semver on any line carrying
 * the marker in a file listed under `extra-files`, so one release rewrites
 * both, and tests/discovery-server-card.test.ts asserts the two agree. Two
 * markers are safe only because that test exists; delete it and they become
 * two things to remember.
 */
export const DISCOVERY_VERSION = '1.45.1'; // x-release-please-version
