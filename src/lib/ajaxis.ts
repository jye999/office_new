// Ajaxis::BtDeleting($title, $body, $link) — BootstrapDeleteConfirmationMessage
// (amranidev/ajaxis). Blade {{ }} escaping = Laravel e().
// T16/T17 carry their own copies in the module files; T18+ should use this one.
export function e(s: unknown): string {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function btDeleting(title: string, body: string, link: string): string {
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
