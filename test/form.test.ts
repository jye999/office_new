import { describe, expect, it } from 'vitest';
import { FormBuilder, type FormBuilderContext } from '../src/view.js';
import { registerRoute } from '../src/router.js';
import { config as appConfig } from '../src/config.js';

// Fixed-context form builder: token, no old input, request input per test, no errors.
function makeForm(overrides: Partial<FormBuilderContext> = {}) {
  const ctx: FormBuilderContext = {
    token: () => 'TOKEN',
    oldInput: () => null,
    requestInput: () => null,
    errorsAny: () => false,
    currentUrl: () => `${appConfig.APP_URL.replace(/\/+$/, '')}/current`,
    absoluteUrl: (p?: string) => `${appConfig.APP_URL.replace(/\/+$/, '')}/${(p ?? '').replace(/^\/+/, '')}`,
    ...overrides,
  };
  return new FormBuilder(ctx);
}

const base = appConfig.APP_URL.replace(/\/+$/, '');

describe('FormBuilder (laravelcollective/html 5.2 parity)', () => {
  it('open(): attribute order method, action, accept-charset + CSRF token', () => {
    expect(makeForm().open({ url: '/login' })).toBe(
      `<form method="POST" action="${base}/login" accept-charset="UTF-8"><input name="_token" type="hidden" value="TOKEN">`,
    );
  });

  it('open(): GET form has no token', () => {
    expect(makeForm().open({ url: '/q', method: 'GET' })).toBe(
      `<form method="GET" action="${base}/q" accept-charset="UTF-8">`,
    );
  });

  it('open(): PUT spoofing appends _method then token; extra options after accept-charset', () => {
    registerRoute('t01.form', '/t01');
    expect(makeForm().open({ route: 't01.form', method: 'PUT', id: 'f1', class: 'x' })).toBe(
      `<form method="POST" action="/t01" accept-charset="UTF-8" id="f1" class="x"><input name="_method" type="hidden" value="PUT"><input name="_token" type="hidden" value="TOKEN">`,
    );
  });

  it('open(): files adds enctype multipart', () => {
    expect(makeForm().open({ url: '/up', files: true })).toBe(
      `<form method="POST" action="${base}/up" accept-charset="UTF-8" enctype="multipart/form-data"><input name="_token" type="hidden" value="TOKEN">`,
    );
  });

  it('text(): order options, name, type, value; no id without label', () => {
    expect(makeForm().text('name', 'v', { class: 'f' })).toBe(
      `<input class="f" name="name" type="text" value="v">`,
    );
  });

  it('label() registers id; old input wins over value; model is last resort', () => {
    const form = makeForm();
    expect(form.label('name')).toBe('<label for="name">Name</label>');
    expect(form.text('name', 'v')).toBe(`<input name="name" type="text" value="v" id="name">`);

    const oldForm = makeForm({ oldInput: (k) => (k === 'name' ? 'old' : null) });
    expect(oldForm.text('name', 'v')).toBe(`<input name="name" type="text" value="old">`);

    const reqForm = makeForm({ requestInput: (k) => (k === 'name' ? 'req' : null) });
    expect(reqForm.text('name', 'v')).toBe(`<input name="name" type="text" value="req">`);

    const modelForm = makeForm();
    modelForm.model({ name: 'from-model' }, { url: '/m' });
    expect(modelForm.text('name')).toBe(`<input name="name" type="text" value="from-model">`);
  });

  it('hidden/file/submit/button/textarea/select output', () => {
    const form = makeForm();
    expect(form.hidden('id', 5)).toBe(`<input name="id" type="hidden" value="5">`);
    expect(form.file('f')).toBe(`<input name="f" type="file">`);
    expect(form.submit('Go')).toBe(`<input type="submit" value="Go">`);
    expect(form.button('B')).toBe(`<button type="button">B</button>`);
    expect(form.textarea('body')).toBe(`<textarea name="body" cols="50" rows="10" id="body"></textarea>`);
    expect(form.textarea('body', 'hi', { rows: 3 })).toBe(
      `<textarea rows="3" name="body" cols="50" id="body">hi</textarea>`,
    );
    expect(form.select('s', { a: 'A', b: 'B' }, 'b')).toBe(
      `<select id="s" name="s"><option value="a">A</option><option value="b" selected="selected">B</option></select>`,
    );
    expect(form.select('s', { a: 'A' }, null, {}, { a: { class: 'x' } })).toBe(
      `<select id="s" name="s"><option value="a" class="x">A</option></select>`,
    );
  });

  it('placeholder option: selected only when nothing selected', () => {
    const form = makeForm();
    expect(form.select('s', { a: 'A' }, null, { placeholder: 'pick' })).toBe(
      `<select id="s" name="s"><option selected="selected" value="">pick</option><option value="a">A</option></select>`,
    );
    expect(form.select('s', { a: 'A' }, 'a', { placeholder: 'pick' })).toBe(
      `<select id="s" name="s"><option value="">pick</option><option value="a" selected="selected">A</option></select>`,
    );
  });

  it('escapeHtml in attributes and option display', () => {
    const form = makeForm();
    expect(form.select('s', { a: '<A>' }, 'a')).toBe(
      `<select id="s" name="s"><option value="a" selected="selected">&lt;A&gt;</option></select>`,
    );
  });
});
