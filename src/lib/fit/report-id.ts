/**
 * A permalink id: 128 bits, base64url, 22 characters.
 *
 * THE ID IS THE CAPABILITY -- `/fit/r/<id>` asks for nothing else (04 §2's
 * shareable permalink). Two things follow, and both are requirements rather
 * than notes: it must come from the CSPRNG, and it must never be derived from
 * anything about the report. A derived id is a guessable id, and a guessable
 * id is a public report.
 *
 * ITS OWN MODULE since #269, and the reason is about direction rather than
 * tidiness. This used to sit in src/lib/fit/client.ts, whose whole subject is
 * how the SITE talks to the MCP Worker. The MCP Worker mints the id now,
 * because it is the side that opens the row, and importing the site's client
 * module to reach one function would assert a dependency that does not exist.
 */
export function newReportId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
