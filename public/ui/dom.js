// Small DOM and display helpers. No workspace state or network access.
export const $ = selector => document.querySelector(selector);
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key.startsWith('aria-') && typeof value === 'boolean') node.setAttribute(key, String(value));
    else if (value !== false && value !== null && value !== undefined) node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function shortSha(value) { return value ? value.slice(0, 10) : "Pending"; }
export function explainDisabledButtons() {
  for (const button of document.querySelectorAll('button')) {
    let wrapper = button.parentElement;
    if (button.disabled && button.title && !wrapper?.classList.contains('disabled-action')) {
      wrapper = el('span', { class: 'disabled-action' });
      button.replaceWith(wrapper); wrapper.append(button);
    }
    if (wrapper?.classList.contains('disabled-action')) {
      wrapper.hidden = button.hidden;
      const reason = button.disabled ? button.title : '';
      wrapper.dataset.help = reason;
      // Disabled buttons ignore pointer input; the wrapper owns their visible help.
      // A native title here would duplicate the DOM tooltip on hover.
      wrapper.removeAttribute('title');
      if (button.id) wrapper.id = `help-${button.id}`;
      wrapper.tabIndex = reason ? 0 : -1;
      if (reason) wrapper.setAttribute('aria-label', `${button.textContent.trim()}: ${reason}`);
      else wrapper.removeAttribute('aria-label');
    }
  }
}
export function dateTime(value) {
  if (!value) return "Pending";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}
export function timeOnly(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(date);
}
export function panel(title, body, extra = null) {
  return el("section", { class: "panel" }, el("div", { class: "panel-header" }, el("h2", {}, title), extra), body);
}
export function captureFocus(content) {
  const active = document.activeElement;
  if (!content.contains(active) || !active.id) return null;
  return { id: active.id, start: active.selectionStart, end: active.selectionEnd };
}
export function restoreFocus(saved) {
  if (!saved) return;
  const element = document.getElementById(saved.id);
  if (!element) return;
  element.focus({ preventScroll: true });
  if (typeof element.setSelectionRange === "function" && saved.start !== null) element.setSelectionRange(saved.start, saved.end);
}
