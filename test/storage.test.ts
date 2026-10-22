// T04: storage disks (local only, temp dir — no S3/SFTP network in unit tests).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports
let disk: (name: string) => import('../src/storage.js').Disk;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'storage-test-'));
  process.env.STORAGE_DIR = dir;
  ({ disk } = await import('../src/storage.js'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('local disk', () => {
  it('put/exists/get/delete roundtrip with subdir creation', async () => {
    const d = disk('product_image_icon');
    const file = join(d.pathPrefix(), 'chat', '1_123.0.jpg');
    expect(file).toContain('product_images_icon');
    expect(await d.exists('chat/1_123.0.jpg')).toBe(false);
    await d.put('chat/1_123.0.jpg', Buffer.from('img'));
    expect(await d.exists('chat/1_123.0.jpg')).toBe(true);
    expect(await d.get('chat/1_123.0.jpg')).toEqual(Buffer.from('img'));
    await d.delete('chat/1_123.0.jpg');
    expect(await d.exists('chat/1_123.0.jpg')).toBe(false);
  });

  it('maps disk names to the old config/filesystems.php roots', () => {
    const roots = {
      local: 'app',
      labels: 'app/public/labels',
      chat: 'app/public/chat',
      product_image_full: 'app/public/product_images_full',
      supplier_product_image_icon: 'app/public/supplier_product_images_icon',
      backups: 'backups',
    };
    for (const [name, rel] of Object.entries(roots)) {
      expect(disk(name).pathPrefix()).toBe(join(dir, rel));
    }
  });

  it('throws on unknown local disk name', () => {
    expect(() => disk('nope')).toThrow('Unknown disk');
  });
});
