const BLOCKED_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta']);
const TAG_NAME = /^[a-z][a-z0-9-]*$/;
const CLASS_NAME = /^[a-z0-9 _-]{0,512}$/i;
const SAFE_ATTRIBUTE = /^(?:aria-[a-z0-9-]+|data-[a-z0-9-]+|id|role|title|tabindex)$/;

function safeTagName(value) {
  return typeof value === 'string' && TAG_NAME.test(value) && !BLOCKED_TAGS.has(value.toLowerCase());
}

function requireDocument(document) {
  if (document === null || typeof document !== 'object' || typeof document.createElement !== 'function') {
    throw new TypeError('A DOM document is required.');
  }
  return document;
}

function setClassName(element, className) {
  if (className === undefined) return;
  if (typeof className !== 'string' || !CLASS_NAME.test(className)) {
    throw new TypeError('DOM class name is invalid.');
  }
  if (className !== '') element.setAttribute('class', className);
}

function setSafeAttributes(element, attributes) {
  if (attributes === undefined) return;
  if (attributes === null || typeof attributes !== 'object' || Array.isArray(attributes)) {
    throw new TypeError('DOM attributes are invalid.');
  }
  for (const [name, value] of Object.entries(attributes)) {
    const normalizedName = name.toLowerCase();
    if (!SAFE_ATTRIBUTE.test(normalizedName) || /[\u0000-\u001f\u007f]/u.test(String(value))) {
      throw new TypeError('DOM factory received an unsafe attribute.');
    }
    element.setAttribute(normalizedName, String(value));
  }
}

export function createTextElement(document, tagName, { text = '', className, attributes } = {}) {
  const factory = requireDocument(document);
  if (!safeTagName(tagName)) throw new TypeError('DOM factory requires a safe tag.');
  const element = factory.createElement(tagName.toLowerCase());
  element.textContent = String(text);
  setClassName(element, className);
  setSafeAttributes(element, attributes);
  return element;
}

export function normalizeExternalUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    return null;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
    return null;
  }
  return url.href;
}

export function createSafeLink(document, { text = '', url, className } = {}) {
  const normalizedUrl = normalizeExternalUrl(url);
  if (normalizedUrl === null) {
    return createTextElement(document, 'span', {
      text,
      className,
      attributes: { 'aria-disabled': 'true' },
    });
  }
  const link = createTextElement(document, 'a', { text, className });
  link.setAttribute('href', normalizedUrl);
  link.setAttribute('rel', 'noopener noreferrer');
  link.setAttribute('target', '_blank');
  return link;
}

export function replaceChildren(container, children) {
  if (
    container === null ||
    typeof container !== 'object' ||
    typeof container.replaceChildren !== 'function' ||
    !Array.isArray(children)
  ) {
    throw new TypeError('DOM replacement input is invalid.');
  }
  container.replaceChildren(...children);
}
