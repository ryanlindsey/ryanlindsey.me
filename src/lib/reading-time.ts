import getReadingTime from 'reading-time';

export interface ReadingTime {
  text: string;
  minutes: number;
  words: number;
}

/**
 * Astro 7's Satteri processor does not run remark plugins, which is how reading
 * time is usually injected. It does not need to: a Content Layer entry carries
 * its raw markdown on `entry.body`, so this is a direct call with no pipeline.
 */
export function readingTimeFor(body: string | undefined): ReadingTime {
  const stats = getReadingTime(body ?? '');
  return {
    text: stats.text,
    minutes: Math.max(1, Math.round(stats.minutes)),
    words: stats.words,
  };
}
