// The fixed keys the private tier reads, as data both scripts/private-doc.mjs
// and tests/private-doc-keys.test.ts can import. The script cannot import the
// TypeScript that owns PROFILE_KEYS and AUTHORING_KEYS, so this is a copy,
// and the test is what pins the copy to the original.
//
// FIXED KEYS ONLY, AND NEVER A NARRATIVE KEY. private-doc.mjs's header says
// why the script has no `list` verb: enumerating the bucket would enumerate
// every audience. These four are different in kind. Every token carrying
// `profile` is promised the first three and the owner's drafting client is
// promised the fourth, so an absent one is a tool that errors for every
// reader at once, and a roster over them names no audience.
//
// MEASURED 2026-09-20, the first time a real client connected to the deployed
// private tier: all three profile keys were absent, four audiences held
// `profile` on live tokens, and the only symptom was "That document is not
// available on this tier yet" from three of the six tools their grant listed.
export const FIXED_KEYS = Object.freeze([
  'profile/availability.md',
  'profile/references.md',
  'profile/compensation.md',
  'authoring/narrative-brief.md',
]);
