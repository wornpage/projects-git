// One visible error notice follows the active native dialog's top layer. It does
// not scroll the page or take focus away from the action that failed.
export function createErrorNotice(document) {
  const notice = document.getElementById('error-banner');
  const message = document.getElementById('error-text');
  const dismiss = document.getElementById('dismiss-error');
  let opener = null;
  for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('close', () => {
    if (notice.parentElement === dialog) document.body.append(notice);
  });
  function show(text, openerId) {
    if (openerId) opener = document.getElementById(openerId);
    else if (document.activeElement !== dismiss && document.activeElement !== message) opener = document.activeElement;
    const surface = document.querySelector('dialog[open]') ?? document.body;
    if (notice.parentElement !== surface) surface.append(notice);
    message.textContent = text;
    notice.hidden = false;
  }
  function clear() {
    const restore = document.activeElement === dismiss || document.activeElement === message;
    notice.hidden = true;
    message.textContent = '';
    if (restore) (opener?.isConnected ? opener : opener?.id ? document.getElementById(opener.id) : null)?.focus({preventScroll: true});
    opener = null;
    if (notice.parentElement !== document.body) document.body.append(notice);
  }
  return {show, clear};
}
