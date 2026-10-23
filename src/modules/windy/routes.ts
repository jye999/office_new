// WindyController (routes/web.php:72-77, role:admin,user,windy).
// No $hidden/$appends on GrantOrder/GrantOrderDetail, so a serialised model is
// every DB column. Quirks kept (NOTES.md): the controller lacks
// create/show/edit/update, so those resource methods 500 (T10/T16 pattern);
// index renders `$order->zipcode` (the column is `zip`) so the Zipcode cell
// is always empty; store() 500s on a data-less TXT file.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { grantOrdersDestroy, grantOrdersExport, grantOrdersIndex, grantOrdersUpload } from '../../lib/grantOrders.js';
import { route, resource } from '../../router.js';
import { sendServer500, url } from '../../view.js';

// Ajaxis::BtDeleting($title, $body, $link): BootstrapDeleteConfirmationMessage
// (same port as T16's; Blade {{ }} escapes like Laravel e()).
function e(s: unknown): string {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function ajaxisBtDeleting(title: string, body: string, link: string): string {
  const head =
    '<div class="modal-dialog" role="document">\n' +
    '    <div class="modal-content">\n' +
    '        <div class="modal-header">\n' +
    '            <button type="button" class="close" data-dismiss="modal" aria-label="Close"><span aria-hidden="true">&times;</span></button>\n' +
    `        <h4 class="modal-title" id="myModalLabel">${e(title)}</h4></div>\n` +
    '        <div class="modal-body">';
  const modalBody = `<div class="modal-body">${body}</div>`;
  const footer =
    '</div>\n' +
    '<div class="modal-footer">\n' +
    '    <button type="button" class="btn btn-default" data-dismiss="modal">Close</button>\n' +
    `    <button type="button" class="destroy btn btn-primary" data-link = "${e(link)}">Agree</button>\n` +
    '</div></div></div>';
  return head + modalBody + footer;
}

async function windyIndex(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await grantOrdersIndex(req, reply, 'WINDY', 'windy/index');
}

async function windyStore(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await grantOrdersUpload(req, reply, 'WINDY', 'TXT', url('windy.index'));
}

async function windyExport(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await grantOrdersExport(req, reply, 'WINDY');
}

// destroy(): deletes by store + orderId, then echoes URL::to('windy.index')
// as a plain HTML body.
async function windyDestroy(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await grantOrdersDestroy(req, reply, 'WINDY', url('windy.index'));
}

// DeleteMsg(): Ajaxis modal HTML for ajax requests; non-ajax returns null.
async function windyDeleteMsg(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const msg = ajaxisBtDeleting('Warning!!', 'Would you like to remove This?', `/windy/${(req.params as { id: string }).id}/delete`);
  if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
    reply.type('text/html; charset=UTF-8').send(msg);
  }
}

export function registerWindyRoutes(app: FastifyInstance): void {
  const roles = ['admin', 'user', 'windy'];
  // Route::resource('windy', ...) — the controller only has
  // index/store/destroy (+helpers); the missing methods 500 like the old app.
  resource(app, '/windy', {
    index: windyIndex,
    create: async (req, reply) => sendServer500(req, reply),
    store: windyStore,
    show: async (req, reply) => sendServer500(req, reply),
    edit: async (req, reply) => sendServer500(req, reply),
    update: async (req, reply) => sendServer500(req, reply),
    destroy: windyDestroy,
  }, { roles });
  // Later registration wins: windy.index points at /windy.index (not /windy).
  route(app, { verb: 'get', path: '/windy.index', name: 'windy.index', roles, handler: windyIndex });
  route(app, { verb: 'post', path: '/windy.export', name: 'windy.export', roles, handler: windyExport });
  route(app, { verb: 'get', path: '/windy/{id}/delete', roles, handler: windyDestroy });
  route(app, { verb: 'get', path: '/windy/{id}/deleteMsg', roles, handler: windyDeleteMsg });
}
