// POST /api/product/:id/images with the multipart field names the product page and the API send.
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import sharp from 'sharp';
import { it, expect } from 'vitest';
import { db } from '../src/db.js';
import { parseLaravelQuery, registerHttpHelpers } from '../src/http.js';
import { registerProductRoutes } from '../src/modules/product/routes.js';
import { installRouter } from '../src/router.js';
import { registerViewPlugins } from '../src/view.js';
it('accepts the page\'s files[] field and does not hang on other file parts', async () => {
  const u = await db.selectFrom('os_users').innerJoin('os_user_has_roles','os_user_has_roles.user_id','os_users.id').innerJoin('os_roles','os_roles.id','os_user_has_roles.role_id').select('os_users.id').where('os_roles.name','=','admin').executeTakeFirst();
  const app = Fastify({ querystringParser: parseLaravelQuery });
  void app.register(multipart, { limits: { fileSize: 50*1024*1024 } }); void app.register(registerHttpHelpers); void registerViewPlugins(app);
  installRouter(app); registerProductRoutes(app);
  app.addHook('preHandler', async (req) => { (req.session as Record<string, unknown>)['user_id'] = u!.id; });
  const buf = await sharp({create:{width:4032,height:3024,channels:3,background:{r:200,g:30,b:30}}}).jpeg().toBuffer();
  const out: string[] = [];
  for (const field of ['files[]', 'files']) {
    const b='XB';
    const body = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${field}"; filename="IMG_1.JPG"\r\nContent-Type: image/jpeg\r\n\r\n`), buf, Buffer.from(`\r\n--${b}--\r\n`)]);
    const t=Date.now();
    const res = await app.inject({ method:'POST', url:'/api/product/999999/images', headers:{'content-type':'multipart/form-data; boundary='+b}, payload: body });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toHaveLength(1);
    void t; out.push(field);
  }
  await db.deleteFrom('os_product_images').where('product_id','=','999999').execute();
  await db.destroy();
}, 60000);
