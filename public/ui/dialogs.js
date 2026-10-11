// One native-dialog lifecycle: Escape, backdrop dismissal, guards and focus restoration.
export function createDialogManager(document) {
  const openers = new Map();
  const registered = new Set();

  function register(id, canDismiss = () => true) {
    if (registered.has(id)) throw new Error(`Dialog already registered: ${id}`);
    const dialog = document.getElementById(id);
    if (!dialog) throw new Error(`Dialog not found: ${id}`);
    registered.add(id);
    let backdropPress = false;
    const onBackdrop = event => {
      if (event.target !== dialog) return false;
      const bounds = dialog.getBoundingClientRect();
      return event.clientX < bounds.left || event.clientX > bounds.right ||
        event.clientY < bounds.top || event.clientY > bounds.bottom;
    };
    dialog.addEventListener('pointerdown', event => {
      backdropPress = event.button === 0 && onBackdrop(event);
    });
    dialog.addEventListener('pointercancel', () => { backdropPress = false; });
    dialog.addEventListener('click', event => {
      const dismiss = backdropPress && onBackdrop(event);
      backdropPress = false;
      if (dismiss && canDismiss()) dialog.close();
    });
    dialog.addEventListener('cancel', event => {
      if (!canDismiss()) event.preventDefault();
    });
    dialog.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      if (canDismiss()) dialog.close();
    });
    dialog.addEventListener('close', () => {
      backdropPress = false;
      const opener = openers.get(id);
      openers.delete(id);
      const target = opener?.isConnected ? opener : opener?.id ? document.getElementById(opener.id) : null;
      target?.focus({preventScroll: true});
    });
  }

  function show(id, focusSelector, opener = document.activeElement) {
    if (!registered.has(id)) throw new Error(`Unregistered dialog: ${id}`);
    openers.set(id, opener);
    document.getElementById(id).showModal();
    if (focusSelector) document.querySelector(focusSelector)?.focus();
  }

  // Navigation will focus its destination instead of returning to the opener.
  function skipFocusRestore(id) { openers.delete(id); }
  return {register, show, skipFocusRestore};
}
