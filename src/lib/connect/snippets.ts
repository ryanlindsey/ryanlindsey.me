import { MCP_ENDPOINT } from '../nav';
import { buildInitialize } from './handshake';

/**
 * The three setup blocks on /connect (#395), built from `MCP_ENDPOINT` so the
 * address a reader pastes has one spelling, and from `buildInitialize` so the
 * `curl` is the request the page's button sends rather than a second copy of
 * it.
 *
 * The client steps were checked on 2026-09-24: `claude mcp add --help` for
 * Claude Code, and the Claude help center article on custom connectors for the
 * claude.ai menu path, which had moved from Settings to Customize since the
 * plan was written. The help center says nothing about request headers, so the
 * header steps rest on the owner connector added on 2026-09-20, which is where
 * "the value is sent exactly as typed" and "headers cannot be edited
 * afterward" were learned (the first attempt pasted a bare token and was
 * silently served the public tier).
 */

export const TOKEN_PLACEHOLDER = '<token>';

export interface SetupVariant {
  steps: readonly string[];
  /** Shown in a code block with a copy button. */
  command?: string;
}

export interface SetupClient {
  id: 'claude' | 'claude-code' | 'http';
  label: string;
  anonymous: SetupVariant;
  withToken: SetupVariant;
}

const BEARER = `Bearer ${TOKEN_PLACEHOLDER}`;

const curl = (headers: readonly string[]): string =>
  [
    `curl ${MCP_ENDPOINT} \\`,
    ...[
      'content-type: application/json',
      'accept: application/json, text/event-stream',
      ...headers,
    ].map((header) => `  -H '${header}' \\`),
    `  -d '${JSON.stringify(buildInitialize())}'`,
  ].join('\n');

export const SETUP_CLIENTS: readonly SetupClient[] = [
  {
    id: 'claude',
    label: 'Claude',
    anonymous: {
      steps: [
        'In claude.ai or the desktop app, open Customize, then Connectors, press the plus button and choose Add custom connector.',
        'Give it a name and paste the endpoint as its URL. Claude Desktop and Cowork pick up the same connector.',
      ],
      command: MCP_ENDPOINT,
    },
    withToken: {
      steps: [
        `On the second step of the same dialog, add a request header named authorization with the value ${BEARER}, including the word Bearer.`,
        'A connector cannot have its headers edited once it exists. To change the token, remove the connector and add it again.',
      ],
    },
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    anonymous: {
      steps: [
        'Run this in a terminal. It adds the server to the current project; add --scope user to have it everywhere.',
      ],
      command: `claude mcp add --transport http ryanlindsey-me ${MCP_ENDPOINT}`,
    },
    withToken: {
      steps: ['The same command, with the token as a header.'],
      command: `claude mcp add --transport http ryanlindsey-me ${MCP_ENDPOINT} --header "Authorization: ${BEARER}"`,
    },
  },
  {
    id: 'http',
    label: 'Any other client',
    anonymous: {
      steps: [
        'Any client that speaks Streamable HTTP needs the endpoint and nothing else. This is the handshake as a request, the same one the button above sends.',
      ],
      command: curl([]),
    },
    withToken: {
      steps: [
        'The token travels in the authorization header as a bearer, and nowhere else: not a cookie, not a query parameter.',
      ],
      command: curl([`authorization: ${BEARER}`]),
    },
  },
];
