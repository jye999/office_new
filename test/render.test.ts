import Fastify from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { render, registerViewPlugins } from '../src/view.js';

// Boots a bare app (no DB access: no user_id in the session) and renders the
// dev test view that extends `layout`, proving the engine + globals + blocks wire up.
describe('render() integration', () => {
  let html: string;

  beforeAll(async () => {
    const app = Fastify();
    await registerViewPlugins(app);
    app.get('/t', async (req, reply) => {
      await render(req, reply, 'layout-test');
    });
    const res = await app.inject({ method: 'GET', url: '/t' });
    html = res.body;
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    await app.close();
  });

  it('extends layout: title/styles/scripts blocks overridden, head present', () => {
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toMatch(/<title>\s*Layout Test\s*<\/title>/);
    expect(html).toContain('<link rel="stylesheet" href="/test-styles.css">');
    expect(html).toContain('<script>var layoutTest = true;</script>');
    expect(html).toContain('<div id="layout-test">');
    expect(html).toContain('id="quickInventoryModal"'); // nav rendered
    expect(html).toContain('<footer class="clearfix">');
  });

  it('injects auth/errors/session/old/csrf/form globals', () => {
    expect(html).toContain('config: Angel Isabella');
    expect(html).toContain('trans: These credentials do not match our records.');
    expect(html).toMatch(/csrf: [0-9a-f]{40}/);
    expect(html).toContain('&lt;input type=&quot;hidden&quot; name=&quot;_token&quot;');
    expect(html).toContain('old: none');
    expect(html).toContain('errors: 0 any=false');
    expect(html).toContain('out-of-role');
    expect(html).toContain('&lt;label for=&quot;name&quot;&gt;Name&lt;/label&gt;');
    expect(html).toContain('&lt;select id=&quot;s&quot; name=&quot;s&quot;&gt;');
  });

  it('date/number_format/json_encode globals render', () => {
    expect(html).toContain('num: 1,234.50');
    expect(html).toMatch(/json: \{&quot;a&quot;:1,&quot;b&quot;:&quot;x&#92;\/y&quot;\}/);
    expect(html).toMatch(/date: \d{4}-\d{2}-\d{2}/);
  });
});
