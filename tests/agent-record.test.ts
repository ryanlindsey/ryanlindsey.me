import { describe, expect, test, vi } from 'vitest';
import {
  AE_BLOB_FIELDS,
  AE_SEARCH_BLOB_FIELDS,
  AE_SEARCH_DOUBLE_FIELDS,
  dataPointFor,
  recordAgentEvent,
  searchDataPointFor,
} from '../src/lib/agent-intel/record';
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

  test('a search row appends to the legend rather than reordering it', () => {
    // Issue #146. `AE_BLOB_FIELDS`'s own contract is APPEND, never insert and
    // never reorder, because /ops addresses these by NUMBER over the whole
    // dataset with no surface filter -- so a search row that shifted
    // `route_class` off `blob3` would silently re-label every historical row in
    // the query that groups by it, with both sides still internally consistent.
    // This test is what makes the two legend arrays load-bearing rather than
    // decorative: they are the declaration, and the positions below are what
    // the code actually emits.
    const point = searchDataPointFor(event, { results: 3, cacheHit: true, type: 'writing' });
    expect(AE_SEARCH_BLOB_FIELDS).toEqual(['search_type']);
    expect(AE_SEARCH_DOUBLE_FIELDS).toEqual(['result_count', 'cache_hit']);
    expect(point.blobs?.slice(0, AE_BLOB_FIELDS.length)).toEqual(dataPointFor(event).blobs);
    expect(point.blobs?.slice(AE_BLOB_FIELDS.length)).toEqual(['writing']);
    expect(point.doubles?.slice(2)).toEqual([3, 1]);
  });

  test('an unfiltered search names its filter rather than leaving a hole', () => {
    // `blob7` is a bounded label and an absent one would be an empty string
    // sitting in a column whose whole value is that it is cheap to group by.
    const point = searchDataPointFor(event, { results: 0, cacheHit: false, type: null });
    expect(point.blobs?.[6]).toBe('all');
    expect(point.doubles?.[3]).toBe(0);
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
