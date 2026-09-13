/**
 * The primary navigation, in the order the 2026-09 redesign puts it.
 *
 * A module because three surfaces are meant to read it. Today only one does:
 * the header rule bar. The mobile full-screen overlay and the footer's SITE
 * column (which will carry the first three -- Ask my agent stays nav-only,
 * since the footer is where it used to live and repeating it there would
 * undo the promotion) arrive with the issues that own them.
 *
 * Ops and AI Policy are deliberately absent. They were demoted out of the
 * primary nav in review: they are about the site rather than part of reading
 * it, and they now live in the footer's SYSTEM column.
 */
export const NAV_LINKS = [
  { href: '/writing', label: 'Writing' },
  { href: '/work', label: 'Work' },
  { href: '/resume', label: 'Resume' },
  { href: '/chat', label: 'Ask my agent' },
] as const;
