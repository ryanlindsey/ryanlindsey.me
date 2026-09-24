import { expect, test } from 'vitest';
import {
  buildInitialize,
  CONNECT_ERROR_COPY,
  parseInitialize,
  REQUESTED_PROTOCOL_VERSION,
} from '../src/lib/connect/handshake';

/**
 * The live shape, captured from production on 2026-09-24 with the tool list
 * shortened: an SSE body with one `event: message` frame. The `instructions`
 * field is the reason this module exists -- it names every public tool.
 */
const LIVE = [
  'event: message',
  'data: {"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true},"resources":{"listChanged":true}},"serverInfo":{"name":"ryanlindsey-me","version":"1.41.4"},"instructions":"get_contact: how to reach Ryan."},"jsonrpc":"2.0","id":1}',
  '',
  '',
].join('\n');

test('the request is a JSON-RPC initialize that names this page as its client', () => {
  const request = buildInitialize();
  expect(request.method).toBe('initialize');
  expect(request.jsonrpc).toBe('2.0');
  expect(request.params.protocolVersion).toBe(REQUESTED_PROTOCOL_VERSION);
  expect(request.params.clientInfo.name).toBe('ryanlindsey.me/connect');
});

test('reads the SSE body the endpoint returns today', () => {
  expect(parseInitialize(LIVE)).toEqual({
    name: 'ryanlindsey-me',
    version: '1.41.4',
    protocolVersion: '2025-06-18',
    capabilities: ['resources', 'tools'],
  });
});

test('never returns instructions, or anything else it was not asked for', () => {
  const hello = parseInitialize(LIVE);
  expect(Object.keys(hello ?? {}).sort()).toEqual([
    'capabilities',
    'name',
    'protocolVersion',
    'version',
  ]);
  expect(JSON.stringify(hello)).not.toContain('get_contact');
});

test('reads a plain JSON body', () => {
  const body = LIVE.split('\n')[1].slice('data: '.length);
  expect(parseInitialize(body)?.name).toBe('ryanlindsey-me');
});

test('finds the result behind CRLF endings and an earlier frame', () => {
  const body = [
    'event: message',
    'data: {"jsonrpc":"2.0","method":"notifications/message","params":{}}',
    '',
    LIVE,
  ]
    .join('\n')
    .replaceAll('\n', '\r\n');
  expect(parseInitialize(body)?.version).toBe('1.41.4');
});

test('a result with no capabilities still parses, with none listed', () => {
  const body =
    '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"x","version":"1"}}}';
  expect(parseInitialize(body)?.capabilities).toEqual([]);
});

test.each([
  ['an HTML error page', '<!doctype html><title>502</title>'],
  ['an empty body', ''],
  ['a JSON-RPC error', '{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"bad version"}}'],
  ['a result missing serverInfo', '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"x"}}'],
  ['malformed data', 'event: message\ndata: {not json'],
])('%s is not a handshake', (_label, body) => {
  expect(parseInitialize(body)).toBeNull();
});

test('every failure has one sentence', () => {
  for (const copy of Object.values(CONNECT_ERROR_COPY)) {
    expect(copy).toMatch(/^[A-Z].*\.$/);
  }
});
