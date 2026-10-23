// FourController (routes/web.php:81-87, role:admin,user,four).
// Identical to WindyController except $store = 'FOUR', importEbay (CSV file,
// tab-split like the TXT import, redirect to four.ebay) and the route names.
// Quirks kept (NOTES.md): create/show/edit/update resource methods 500;
// index renders `$order->zipcode` (the column is `zip`).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { grantOrdersDestroy, grantOrdersExport, grantOrdersIndex, grantOrdersUpload } from '../../lib/grantOrders.js';
import { route, resource } from '../../router.js';
import { sendServer500, url } from '../../view.js';

// Ajaxis::BtDeleting — same port as the windy module (T16 pattern).
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

async function fourIndex(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await grantOrdersIndex(req, reply, 'FOUR', 'four/index');
}

async function fourStore(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await grantOrdersUpload(req, reply, 'FOUR', 'TXT', url('four.index'));
}

// importEbay(): CSV extension, but the PHP still tab-splits the lines — kept.
async function fourImportEbay(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await grantOrdersUpload(req, reply, 'FOUR', 'CSV', url('four.ebay'));
}

async function fourExport(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await grantOrdersExport(req, reply, 'FOUR');
}

async function fourDestroy(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await grantOrdersDestroy(req, reply, 'FOUR', url('four.index'));
}

async function fourDeleteMsg(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const msg = ajaxisBtDeleting('Warning!!', 'Would you like to remove This?', `/four/${(req.params as { id: string }).id}/delete`);
  if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
    reply.type('text/html; charset=UTF-8').send(msg);
  }
}

export function registerFourRoutes(app: FastifyInstance): void {
  const roles = ['admin', 'user', 'four'];
  resource(app, '/four', {
    index: fourIndex,
    create: async (req, reply) => sendServer500(req, reply),
    store: fourStore,
    show: async (req, reply) => sendServer500(req, reply),
    edit: async (req, reply) => sendServer500(req, reply),
    update: async (req, reply) => sendServer500(req, reply),
    destroy: fourDestroy,
  }, { roles });
  route(app, { verb: 'get', path: '/four.index', name: 'four.index', roles, handler: fourIndex });
  route(app, { verb: 'post', path: '/four.export', name: 'four.export', roles, handler: fourExport });
  route(app, { verb: 'post', path: '/four.ebay', name: 'four.ebay', roles, handler: fourImportEbay });
  route(app, { verb: 'get', path: '/four/{id}/delete', roles, handler: fourDestroy });
  route(app, { verb: 'get', path: '/four/{id}/deleteMsg', roles, handler: fourDeleteMsg });
}
