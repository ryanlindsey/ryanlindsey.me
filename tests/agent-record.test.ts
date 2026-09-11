import { describe, expect, test, vi } from 'vitest';
import { AE_BLOB_FIELDS, dataPointFor, recordAgentEvent } from '../src/lib/agent-intel/record';
import { classifyRequest } from '../src/lib/agent-intel/classify';

const event = {
  classification: classifyRequest(
    {
      userAgent: 'Mozilla/5.0 (compatible; ClaudeBot/1.0)',
      pathname: '/llms.txt',
      accept: null,
      referer: null,
      secFetchMode: null,
    },
    [],
  ),
  surface: 'site' as const,
  status: 200,
  durationMs: 12,
};

describe('dataPointFor', () => {
  test('the blob order matches the published legend, position for position', () => {
    const point = dataPointFor(event);
    expect(AE_BLOB_FIELDS).toEqual([
      'agent_class',
      'agent',
      'route_class',
      'referrer_class',
      'surface',
      'status_class',
    ]);
    expect(point.blobs).toEqual(['agent', 'ClaudeBot', 'agent-signal', 'none', 'site', '2xx']);
  });

  test('the index is the agent class, which is the low-cardinality one', () => {
    expect(dataPointFor(event).indexes).toEqual(['agent']);
  });

  test('doubles carry a count of one and the duration', () => {
    expect(dataPointFor(event).doubles).toEqual([1, 12]);
  });

  test('the status is bucketed, never carried as a raw code', () => {
    expect(dataPointFor({ ...event, status: 404 }).blobs?.[5]).toBe('4xx');
    expect(dataPointFor({ ...event, status: 503 }).blobs?.[5]).toBe('5xx');
    expect(dataPointFor({ ...event, status: 303 }).blobs?.[5]).toBe('3xx');
  });

  test('no blob carries a raw user agent, a path or anything request-identifying', () => {
    const point = dataPointFor(event);
    for (const blob of point.blobs ?? []) {
      expect(blob).not.toContain('Mozilla');
      expect(blob).not.toContain('/llms.txt');
    }
  });

  test('every index stays inside the 96-byte cap', () => {
    const point = dataPointFor(event);
    for (const index of point.indexes ?? []) {
      // `AnalyticsEngineDataPoint['indexes']` is typed `string | ArrayBuffer |
      // null`, so the string-ness is asserted rather than assumed: it is the
      // precondition the byte count below is even meaningful under, and the
      // narrowing is what lets `encode` take it at all.
      expect(typeof index).toBe('string');
      expect(new TextEncoder().encode(index as string).length).toBeLessThanOrEqual(96);
    }
  });
});

describe('recordAgentEvent', () => {
  test('writes exactly one datapoint', () => {
    const writeDataPoint = vi.fn();
    recordAgentEvent({ AE: { writeDataPoint } as never }, event);
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    expect(writeDataPoint.mock.calls[0]?.[0]).toEqual(dataPointFor(event));
  });

  test('a throwing dataset never reaches the caller', () => {
    const writeDataPoint = vi.fn(() => {
      throw new Error('dataset unavailable');
    });
    expect(() => recordAgentEvent({ AE: { writeDataPoint } as never }, event)).not.toThrow();
  });
});
