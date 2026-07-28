'use strict';

const ALLOWED_TAGS = new Set([
  'a',
  'b',
  'blockquote',
  'br',
  'code',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'i',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'span',
  'strong',
  'u',
  'ul',
]);
const VOID_TAGS = new Set(['br', 'img']);
const DROP_WITH_CONTENT = [
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'template',
  'noscript',
  'form',
];

function escapeText(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttribute(value) {
  return escapeText(value).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function decodeNumericEntities(value) {
  return value
    .replace(/&#(\d+);?/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([0-9a-f]+);?/gi, (_, hexadecimal) => String.fromCodePoint(Number.parseInt(hexadecimal, 16)))
    .replace(/&colon;?/gi, ':')
    .replace(/&tab;?/gi, '\t')
    .replace(/&newline;?/gi, '\n');
}

function safeHttpUrl(value) {
  const decoded = decodeNumericEntities(value).replace(/[\u0000-\u0020\u007f]+/g, '');
  try {
    const parsed = new URL(decoded);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function sanitizeAttributes(tag, source) {
  const attributes = [];
  const pattern = /([^\s"'=<>`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (name === 'title' || name === 'aria-label' || (tag === 'img' && name === 'alt')) {
      attributes.push(`${name}="${escapeAttribute(value)}"`);
    } else if (tag === 'a' && name === 'href') {
      const href = safeHttpUrl(value);
      if (href !== null) attributes.push(`href="${escapeAttribute(href)}"`);
    }
  }
  if (tag === 'a' && attributes.some(attribute => attribute.startsWith('href='))) {
    attributes.push('rel="noopener noreferrer"');
  }
  return attributes.length === 0 ? '' : ` ${attributes.join(' ')}`;
}

function sanitizeTag(token) {
  const closing = /^<\s*\//.test(token);
  const match = token.match(/^<\s*\/?\s*([a-zA-Z][a-zA-Z0-9-]*)([\s\S]*?)>$/);
  if (!match) return escapeText(token);
  const tag = match[1].toLowerCase();
  if (!ALLOWED_TAGS.has(tag)) return '';
  if (closing) return VOID_TAGS.has(tag) ? '' : `</${tag}>`;
  return `<${tag}${sanitizeAttributes(tag, match[2])}>`;
}

function sanitizeHtml(input) {
  if (typeof input !== 'string') return '';
  let source = input.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of DROP_WITH_CONTENT) {
    const pattern = new RegExp(`<\\s*${tag}\\b[\\s\\S]*?<\\s*\\/\\s*${tag}\\s*>`, 'gi');
    source = source.replace(pattern, '');
  }
  source = source.replace(/<![^>]*>/g, '');

  return (source.match(/<[^>]*>|[^<]+|</g) ?? [])
    .map(token => (token.startsWith('<') && token.endsWith('>') ? sanitizeTag(token) : escapeText(token)))
    .join('');
}

module.exports = {
  sanitizeHtml,
};
