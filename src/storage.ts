// Local + S3 storage mirroring the old app's config/filesystems.php disks.
// Local roots are storage_path('app/...') in the PHP app; during coexistence
// STORAGE_DIR points at the old app's storage so uploads stay shared.
// SFTP (wayfair-sftp) is used only by the Runner jobs (phase 5).

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import SftpClient from 'ssh2-sftp-client';

const STORAGE_DIR = process.env.STORAGE_DIR ?? '/home/johnny/code/office/storage';

// disk name -> path relative to storage_path()
const LOCAL_DISKS: Record<string, string> = {
  local: 'app',
  public: 'app/public',
  labels: 'app/public/labels',
  follow_up: 'app/public/follow_up',
  bulk_production: 'app/public/bulk_production',
  chat: 'app/public/chat',
  production: 'app/public/production',
  purchase: 'app/public/purchase',
  product_image_full: 'app/public/product_images_full',
  product_image_icon: 'app/public/product_images_icon',
  supplier_product_image_full: 'app/public/supplier_product_images_full',
  supplier_product_image_icon: 'app/public/supplier_product_images_icon',
  backups: 'backups',
};

const S3_DISKS: Record<string, string> = {
  s3: 'angeloffice',
  's3-bulk-production': 'bulk-production',
};

export interface Disk {
  put(path: string, contents: Buffer | string): Promise<void>;
  get(path: string): Promise<Buffer>;
  exists(path: string): Promise<boolean>;
  delete(path: string): Promise<void>;
  // Flysystem adapter pathPrefix() — the disk's absolute root.
  pathPrefix(): string;
}

class LocalDisk implements Disk {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  async put(path: string, contents: Buffer | string): Promise<void> {
    const file = join(this.root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, contents);
  }
  async get(path: string): Promise<Buffer> {
    return readFile(join(this.root, path));
  }
  async exists(path: string): Promise<boolean> {
    try {
      await readFile(join(this.root, path));
      return true;
    } catch {
      return false;
    }
  }
  async delete(path: string): Promise<void> {
    await rm(join(this.root, path), { force: true });
  }
  pathPrefix(): string {
    return this.root;
  }
}

class S3Disk implements Disk {
  private client: S3Client | null = null;
  constructor(private bucket: string) {}
  private s3(): S3Client {
    if (!this.client) {
      this.client = new S3Client({
        region: process.env.AWS_S3_REGION ?? 'us-east-1',
        credentials: { accessKeyId: process.env.AWS_KEY ?? '', secretAccessKey: process.env.AWS_SECRET_KEY ?? '' },
      });
    }
    return this.client;
  }
  async put(path: string, contents: Buffer | string): Promise<void> {
    await this.s3().send(new PutObjectCommand({ Bucket: this.bucket, Key: path, Body: contents }));
  }
  async get(path: string): Promise<Buffer> {
    const res = await this.s3().send(new GetObjectCommand({ Bucket: this.bucket, Key: path }));
    return res.Body ? Buffer.from(await res.Body.transformToByteArray()) : Buffer.alloc(0);
  }
  async exists(path: string): Promise<boolean> {
    try {
      await this.s3().send(new HeadObjectCommand({ Bucket: this.bucket, Key: path }));
      return true;
    } catch (e: any) {
      return e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
    }
  }
  async delete(path: string): Promise<void> {
    await this.s3().send(new DeleteObjectCommand({ Bucket: this.bucket, Key: path }));
  }
  pathPrefix(): string {
    return `s3://${this.bucket}`;
  }
}

class SftpDisk implements Disk {
  private client: SftpClient | null = null;
  constructor() {}
  private sftp(): SftpClient {
    if (!this.client) {
      this.client = new SftpClient();
    }
    return this.client;
  }
  private async withClient<T>(fn: (c: SftpClient) => Promise<T>): Promise<T> {
    const c = this.sftp();
    await c.connect({
      host: process.env.WAYFAIR_SFTP,
      username: process.env.WAYFAIR_SFTP_USERNAME,
      password: process.env.WAYFAIR_SFTP_PASSWORD,
    });
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  async put(path: string, contents: Buffer | string): Promise<void> {
    await this.withClient((c) => c.put(contents, '/' + path));
  }
  async get(path: string): Promise<Buffer> {
    return this.withClient((c) => c.get('/' + path));
  }
  async exists(path: string): Promise<boolean> {
    return this.withClient(async (c) => {
      try {
        await c.stat('/' + path);
        return true;
      } catch {
        return false;
      }
    });
  }
  async delete(path: string): Promise<void> {
    await this.withClient((c) => c.delete('/' + path));
  }
  pathPrefix(): string {
    return `sftp://${process.env.WAYFAIR_SFTP}`;
  }
}

export function disk(name: string): Disk {
  if (name in S3_DISKS) return new S3Disk(S3_DISKS[name]);
  if (name === 'wayfair-sftp') return new SftpDisk();
  const rel = LOCAL_DISKS[name];
  if (!rel) throw new Error(`Unknown disk: ${name}`);
  return new LocalDisk(join(STORAGE_DIR, rel));
}
