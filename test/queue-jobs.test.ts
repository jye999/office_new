// Golden fixtures were produced by serialize(new App\Jobs\X(...)) in the old app's php:7.4 container.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { amzMassPrintLabelProps, frayunMassPrintLabelProps, jobPayload, massPrintLabelProps, serializeJob } from '../src/lib/queueJobs.js';

const golden = JSON.parse(fs.readFileSync(new URL('./fixtures/queue-jobs.json', import.meta.url), 'utf8')) as Array<{ job: string; args: Record<string, unknown>; serialized: string }>;

describe('queue job serialization matches PHP 7.4', () => {
  for (const [i, g] of golden.entries()) {
    it(`${g.job} #${i}`, () => {
      const a = g.args as never;
      const [cls, props] =
        g.job === 'amz'
          ? ['App\\Jobs\\AmzMassPrintLabel', amzMassPrintLabelProps(a)]
          : g.job === 'frayun'
            ? ['App\\Jobs\\FrayunMassPrintLabel', frayunMassPrintLabelProps(a)]
            : ['App\\Jobs\\MassPrintLabel', massPrintLabelProps(a)];
      expect(serializeJob(cls as string, props as never)).toBe(g.serialized);
    });
  }

  it('envelope has the keys RedisQueue writes (id + attempts) and the job timeout/tries', () => {
    const p = JSON.parse(jobPayload('App\\Jobs\\FrayunMassPrintLabel', 'C', { tries: 1, timeout: 600 }));
    expect(Object.keys(p)).toEqual(['displayName', 'job', 'maxTries', 'timeout', 'data', 'id', 'attempts']);
    expect(p).toMatchObject({ maxTries: 1, timeout: 600, attempts: 0, data: { commandName: 'App\\Jobs\\FrayunMassPrintLabel', command: 'C' } });
    expect(p.id).toMatch(/^[A-Za-z0-9]{32}$/);
  });
});
