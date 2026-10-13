// Minimal DOM for deterministic controller tests; browser QA covers real layout/focus.
export function installFakeDOM() {
  const nodes = new Map();
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.id = ''; this.value = ''; this.disabled = false;
      this.open = false; this.isConnected = true; this.listeners = {}; this.children = [];
      this.attrs = {}; this.dataset = {}; this.classList = {add(){},remove(){},toggle(){},contains(){return false;}};
    }
    addEventListener(event, fn) { (this.listeners[event] ??= []).push(fn); }
    async dispatch(event, data = {}) { for (const fn of this.listeners[event] ?? []) await fn({preventDefault(){this.defaultPrevented=true;},target:this,...data}); }
    focus() { document.activeElement = this; }
    contains(node) { return node === this || this.children.some(child => child.contains?.(node)); }
    select() {}
    showModal() { this.open = true; }
    close() { this.open = false; for (const fn of this.listeners.close ?? []) fn({}); }
    setAttribute(key, value) {
      this.attrs[key] = value;
      if (key === 'id') { this.id = value; nodes.set('#' + value, this); }
      if (key === 'value') this.value = value;
      if (['disabled','checked','readonly'].includes(key)) this[key] = true;
    }
    removeAttribute(key) { delete this.attrs[key]; }
    replaceChildren(...values) { delete this.text; this.children = []; this.append(...values); }
    append(...values) { const previous=this.text;delete this.text;if(previous)this.children.push(document.createTextNode(previous));this.children.push(...values); for (const value of values) if (value instanceof Element) value.parentElement = this; }
    prepend(...values) { this.append();this.children.unshift(...values); for (const value of values) if (value instanceof Element) value.parentElement = this; }
    querySelector(selector) {
      for(const child of this.children){
        if(child.tagName?.toLowerCase()===selector || selector.startsWith('#') && child.id===selector.slice(1))return child;
        const match=child.querySelector?.(selector);if(match)return match;
      }
      return null;
    }
    querySelectorAll() { return this.children; }
    scrollIntoView() {}
    reportValidity() { return true; }
    get lastChild() { return this.children.at(-1); }
    get options() { return this.children.filter(node => node.tagName === 'OPTION'); }
    get textContent() { return this.text ?? this.children.map(value => value.textContent ?? String(value)).join(''); }
    set textContent(value) { this.text = value; this.children = []; }
  }
  const $ = selector => {
    if (!nodes.has(selector)) { const node = new Element(); node.id = selector.slice(1); nodes.set(selector,node); }
    return nodes.get(selector);
  };
  const document = {
    activeElement:null, addEventListener(){}, getElementById:id=>$(`#${id}`),
    querySelector:selector=>selector==='dialog[open]'?[...nodes.values()].find(node=>node.open):$(selector),
    querySelectorAll:()=>[], createElement:tag=>new Element(tag),createElementNS:(_namespace,tag)=>new Element(tag),
    createTextNode:text=>{const node=new Element('#text');node.textContent=text;return node;},
  };
  globalThis.document = document;
  globalThis.Node = Element;
  globalThis.location = {origin:'http://localhost:8000'};
  return {$,document,nodes};
}
