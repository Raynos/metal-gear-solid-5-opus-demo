/**
 * dom.js — the two helpers the rest of the UI is built from.
 *
 * `el` is a terse element factory. `write`/`attr` are change-gated setters: the
 * HUD ticks every frame but the DOM is only touched when a value actually
 * differs from what is already on screen. That distinction is the whole reason
 * a DOM HUD costs nothing — an unconditional `textContent =` on twenty nodes
 * per frame dirties style and layout twenty times whether or not anything moved.
 */

/**
 * @param {string} spec  tag plus optional dot-classes, e.g. 'div.hud.alr'
 * @param {object} [props]  attributes; `text` sets textContent, `style` a cssText
 * @param {Array}  [kids]
 */
export function el(spec, props = null, kids = null) {
  const [tag, ...cls] = spec.split('.');
  const node = document.createElement(tag || 'div');
  if (cls.length) node.className = cls.join(' ');
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v === null || v === undefined) continue;
      if (k === 'text') node.textContent = v;
      else if (k === 'style') node.style.cssText = v;
      else node.setAttribute(k, v);
    }
  }
  if (kids) for (const k of kids) if (k) node.appendChild(k);
  return node;
}

/** textContent, only if it changed. */
export function write(node, value) {
  const s = value == null ? '' : String(value);
  if (node.__t === s) return false;
  node.__t = s;
  node.textContent = s;
  return true;
}

/** setAttribute, only if it changed. Pass null/false to remove. */
export function attr(node, name, value) {
  const key = `__a_${name}`;
  const v = value === false || value == null ? null : String(value);
  if (node[key] === v) return false;
  node[key] = v;
  if (v === null) node.removeAttribute(name);
  else node.setAttribute(name, v);
  return true;
}

/** Inline custom property / style, only if it changed. */
export function css(node, prop, value) {
  const key = `__s_${prop}`;
  const v = String(value);
  if (node[key] === v) return false;
  node[key] = v;
  node.style.setProperty(prop, v);
  return true;
}

/** Restart a one-shot CSS animation on `node` by re-adding `cls`. */
export function replay(node, cls) {
  node.classList.remove(cls);
  // Reading offsetWidth forces the style recalc that makes the removal stick.
  // This runs on state CHANGES only (a handful per mission), never per frame.
  void node.offsetWidth;
  node.classList.add(cls);
}
