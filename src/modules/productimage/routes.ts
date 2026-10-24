// ProductImageController (routes/web.php:382-386; role:admin,user,remote): the
// dropzone-style image uploader.
//
// Quirks kept (plan/NOTES.md):
// - GET /productImage renders view `pages.upload`, which does not exist in the
//   old app -> 500.
// - postUpload() reads $form_data['file'] / ['product_id'] without checks: a
//   missing one is an "Undefined index" ErrorException -> 500.
// - deleteUpload() without product_id returns the bare integer 0.
// - sanitize() strips "_" and "." etc. and lowercases; a file name without an
//   extension loses its last character (substr length - strlen(ext) - 1).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomInt, createHash } from 'node:crypto';
import { db, nowDb } from '../../db.js';
import { input } from '../../http.js';
import { image } from '../../images.js';
import { route } from '../../router.js';
import { disk } from '../../storage.js';
import { sendServer500, url } from '../../view.js';

const ROLES = ['admin', 'user', 'remote'];

// strip_tags(): drop <...> tags.
const STRIP = ['~', '`', '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_', '=', '+', '[', '{', ']', '}', '\\', '|', ';', ':', '"', "'",
  '&#8216;', '&#8217;', '&#8220;', '&#8221;', '&#8211;', '&#8212;', 'â€”', 'â€“', ',', '<', '.', '>', '/', '?'];

function sanitize(s: string): string {
  let clean = s.replace(/<[^>]*>?/g, '');
  for (const strip of STRIP) clean = clean.replaceAll(strip, '');
  clean = clean.trim().replace(/\s+/g, '-');
  return clean.toLowerCase();
}

// ProductImageController@getUpload (web.php:382): view 'pages.upload' is missing.
async function getUpload(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await sendServer500(req, reply);
}

// ProductImageController@postUpload -> upload() (web.php:383).
async function postUpload(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  let photo: { filename: string; buffer: Buffer } | null = null;
  const fields: Record<string, unknown> = { ...(req.query as Record<string, unknown>) };
  if (req.isMultipart()) {
    for await (const part of req.parts()) {
      // SAFETY: multipart part shape (file part -> stream, field part -> value).
      const p = part as { fieldname: string; filename?: string; file?: unknown; value?: unknown; toBuffer: () => Promise<Buffer> };
      if (p.file) {
        const buffer = await p.toBuffer();
        if (p.fieldname === 'file' && p.filename) photo = { filename: p.filename, buffer };
      } else fields[p.fieldname] = p.value;
    }
  } else Object.assign(fields, (req.body ?? {}) as Record<string, unknown>);
  if (!photo || !('product_id' in fields)) return sendServer500(req, reply); // undefined index / method on non-file
  const productId = String(fields['product_id']);
  const originalName = photo.filename;
  const dot = originalName.lastIndexOf('.');
  const extension = dot >= 0 ? originalName.slice(dot + 1) : '';
  const withoutExt = originalName.slice(0, Math.max(0, originalName.length - extension.length - 1));
  const filename = sanitize(withoutExt);
  let allowed = `${productId}_${filename}.${extension}`;
  if (await disk('product_image_full').exists(`${productId}.${extension}`)) {
    allowed = `${productId}_${filename}-${createHash('sha1').update(String(randomInt(2147483647))).digest('hex').slice(0, 5)}.${extension}`;
  }
  await disk('product_image_full').put(allowed, await image(photo.buffer).widen(1000, (c) => c.upsize()).stream());
  await disk('product_image_icon').put(allowed, await image(photo.buffer).widen(100, (c) => c.upsize()).stream());
  const now = nowDb();
  // SAFETY: full os_product_images column set + timestamps.
  await db.insertInto('os_product_images')
    .values({ product_id: productId, filename: allowed, original_name: originalName, created_at: now, updated_at: now } as never)
    .execute();
  reply.send({ error: false, code: 200 });
}

// ProductImageController@deleteUpload -> delete() (web.php:384).
async function deleteUpload(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const productId = input<unknown>(req, 'product_id');
  if (productId === null || (typeof productId === 'string' && productId.trim() === '')) {
    return void reply.type('text/html; charset=UTF-8').send('0');
  }
  const found = await db
    .selectFrom('os_product_images')
    .select(['id', 'filename'])
    .where('product_id', '=', String(productId))
    .where('original_name', '=', String(input(req, 'filename') ?? ''))
    .executeTakeFirst();
  if (!found) return void reply.code(400).send({ error: true, code: 400 });
  if (await disk('product_image_full').exists(found.filename)) await disk('product_image_full').delete(found.filename);
  if (await disk('product_image_icon').exists(found.filename)) await disk('product_image_icon').delete(found.filename);
  await db.deleteFrom('os_product_images').where('id', '=', found.id).execute();
  reply.send({ error: false, code: 200 });
}

// ProductImageController@getServerImages (web.php:386).
async function getServerImages(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const productId = input<unknown>(req, 'product_id');
  let q = db.selectFrom('os_product_images').select(['original_name', 'filename']);
  // where('product_id', '=', null) is `is null` in Laravel 5.4.
  q = productId === null ? q.where('product_id', 'is', null) : q.where('product_id', '=', String(productId));
  const images = await q.execute();
  const imageAnswer: { original: string; server: string; size: number }[] = [];
  for (const img of images) {
    if (await disk('product_image_full').exists(img.filename)) {
      imageAnswer.push({
        original: img.original_name,
        server: `${url('/')}/storage/product_images_icon/${img.filename}`,
        size: (await disk('product_image_full').get(img.filename)).length,
      });
    }
  }
  reply.send({ images: imageAnswer });
}

export function registerProductImageRoutes(app: FastifyInstance): void {
  route(app, { verb: 'get', path: '/productImage', name: 'productImage', roles: ROLES, handler: getUpload });
  route(app, { verb: 'post', path: '/productImageUpload', name: 'productImageUpload', roles: ROLES, handler: postUpload });
  route(app, { verb: 'post', path: '/productImageUploadDelete', name: 'productImageUploadDelete', roles: ROLES, handler: deleteUpload });
  route(app, { verb: 'get', path: '/productImageOnServer', name: 'productImageOnServer', roles: ROLES, handler: getServerImages });
}
