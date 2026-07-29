const SAFE_ATTRIBUTES = new Set(['aria-atomic', 'aria-label', 'aria-live', 'aria-pressed', 'id', 'role', 'title']);

export function normalizeSafeWebUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

export function createTextElement(document, tagName, { text = '', className = '', attributes = {} } = {}) {
  if (!document || typeof document.createElement !== 'function') {
    throw new TypeError('A document with createElement is required.');
  }
  if (typeof tagName !== 'string' || !/^[a-z][a-z0-9-]*$/i.test(tagName)) {
    throw new TypeError('Invalid element name.');
  }

  const element = document.createElement(tagName);
  element.textContent = String(text);
  if (className) element.className = String(className);

  for (const [name, value] of Object.entries(attributes)) {
    if (!SAFE_ATTRIBUTES.has(name)) throw new TypeError('Unsafe element attribute.');
    element.setAttribute(name, String(value));
  }
  return element;
}

export function createSafeLink(document, { url, text, className = '' } = {}) {
  const safeUrl = normalizeSafeWebUrl(url);
  if (!safeUrl) return null;
  const link = createTextElement(document, 'a', { text, className });
  link.setAttribute('href', safeUrl);
  link.setAttribute('rel', 'noreferrer noopener');
  return link;
}

export function replaceChildren(container, ...children) {
  if (!container || typeof container.replaceChildren !== 'function') {
    throw new TypeError('A container with replaceChildren is required.');
  }
  container.replaceChildren(...children.filter(Boolean));
}
