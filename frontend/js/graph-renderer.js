import { normalizeExternalUrl } from './dom.js';

export const MAX_GRAPH_NODES = 100;
export const MAX_GRAPH_EDGES = 300;

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const SAFE_IDENTIFIER = /^[^\u0000-\u001f\u007f]{1,256}$/u;
const MAX_LABEL_LENGTH = 160;

class ProfileIsolationError extends Error {
  constructor() {
    super('Knowledge graph data crossed the active profile boundary.');
    this.name = 'ProfileIsolationError';
    this.code = 'PROFILE_ISOLATION_VIOLATION';
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value) {
  return typeof value === 'string' && value.trim() === value && SAFE_IDENTIFIER.test(value) ? value : null;
}

function assertOwner(record, profileId) {
  const observed = [record.profileId, record.profile_id].filter(value => value !== undefined);
  if (observed.some(value => value !== profileId)) throw new ProfileIsolationError();
  return observed.includes(profileId);
}

function clamp(value, minimum, maximum) {
  if (!Number.isFinite(value)) return null;
  return Math.max(minimum, Math.min(maximum, value));
}

function dimension(value, minimum, maximum, fallback) {
  return clamp(value, minimum, maximum) ?? fallback;
}

function svgElement(documentPort, tagName) {
  return documentPort.createElementNS(SVG_NAMESPACE, tagName);
}

function setAttributes(element, attributes) {
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, String(value));
  }
}

function normalizeNodes(records, profileId, width, height) {
  const nodes = [];
  const ids = new Set();
  for (const record of records) {
    if (!isObject(record) || !assertOwner(record, profileId)) continue;
    const id = identifier(record.id);
    if (id === null || ids.has(id) || nodes.length >= MAX_GRAPH_NODES) continue;
    const index = nodes.length;
    const angle = (index / Math.max(1, Math.min(records.length, MAX_GRAPH_NODES))) * Math.PI * 2;
    const fallbackX = width / 2 + Math.cos(angle) * Math.min(width, height) * 0.32;
    const fallbackY = height / 2 + Math.sin(angle) * Math.min(width, height) * 0.32;
    nodes.push(
      Object.freeze({
        id,
        title: typeof record.title === 'string' ? record.title.slice(0, MAX_LABEL_LENGTH) : 'Untitled memory',
        url: normalizeExternalUrl(record.url),
        x: clamp(record.x, 16, width - 16) ?? clamp(fallbackX, 16, width - 16),
        y: clamp(record.y, 16, height - 16) ?? clamp(fallbackY, 16, height - 16),
        score: clamp(record.score ?? record.memoryScore ?? record.memory_score, 0, 1) ?? 0,
      })
    );
    ids.add(id);
  }
  return nodes;
}

function normalizeEdges(records, profileId, nodes) {
  const edges = [];
  const ids = new Set();
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  for (const record of records) {
    if (!isObject(record) || !assertOwner(record, profileId)) continue;
    const id = identifier(record.id);
    const sourceId = identifier(record.sourceId ?? record.source_id);
    const targetId = identifier(record.targetId ?? record.target_id);
    if (
      id === null ||
      sourceId === null ||
      targetId === null ||
      sourceId === targetId ||
      ids.has(id) ||
      !nodeById.has(sourceId) ||
      !nodeById.has(targetId) ||
      edges.length >= MAX_GRAPH_EDGES
    ) {
      continue;
    }
    edges.push(
      Object.freeze({
        id,
        source: nodeById.get(sourceId),
        target: nodeById.get(targetId),
        relationship:
          typeof record.relationship === 'string' ? record.relationship.slice(0, MAX_LABEL_LENGTH) : 'related',
        confidence: clamp(record.confidence, 0, 1) ?? 0,
      })
    );
    ids.add(id);
  }
  return edges;
}

function appendEdge(documentPort, layer, edge) {
  const line = svgElement(documentPort, 'line');
  setAttributes(line, {
    x1: edge.source.x,
    y1: edge.source.y,
    x2: edge.target.x,
    y2: edge.target.y,
    'stroke-width': 1 + edge.confidence * 3,
    class: 'knowledge-graph-edge',
    'aria-hidden': 'true',
  });
  const title = svgElement(documentPort, 'title');
  title.textContent = edge.relationship;
  line.appendChild(title);
  layer.appendChild(line);
}

function appendNode(documentPort, layer, node, onActivate) {
  const wrapper = svgElement(documentPort, node.url === null ? 'g' : 'a');
  setAttributes(wrapper, {
    tabindex: 0,
    role: node.url === null ? (onActivate ? 'button' : 'group') : 'link',
    'aria-label': node.title,
    class: 'knowledge-graph-node',
  });
  if (node.url !== null) {
    setAttributes(wrapper, {
      href: node.url,
      target: '_blank',
      rel: 'noopener noreferrer',
    });
  }

  const circle = svgElement(documentPort, 'circle');
  setAttributes(circle, {
    cx: node.x,
    cy: node.y,
    r: 7 + node.score * 11,
    class: 'knowledge-graph-node-marker',
  });
  wrapper.appendChild(circle);

  const label = svgElement(documentPort, 'text');
  setAttributes(label, {
    x: node.x,
    y: node.y + 26,
    'text-anchor': 'middle',
    class: 'knowledge-graph-node-label',
  });
  label.textContent = node.title;
  wrapper.appendChild(label);

  if (onActivate) {
    const activate = () => onActivate(Object.freeze({ id: node.id, title: node.title, url: node.url }));
    wrapper.addEventListener('click', activate);
    wrapper.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.key === ' ') event.preventDefault();
      activate();
    });
  }
  layer.appendChild(wrapper);
}

export function renderKnowledgeGraph({
  document: documentPort,
  container,
  profileId,
  nodes: rawNodes,
  edges: rawEdges,
  width = 800,
  height = 480,
  onActivate,
} = {}) {
  if (
    documentPort === null ||
    typeof documentPort !== 'object' ||
    typeof documentPort.createElementNS !== 'function' ||
    container === null ||
    typeof container !== 'object' ||
    typeof container.replaceChildren !== 'function' ||
    identifier(profileId) === null ||
    !Array.isArray(rawNodes) ||
    !Array.isArray(rawEdges) ||
    (onActivate !== undefined && typeof onActivate !== 'function')
  ) {
    throw new TypeError('Knowledge graph configuration is invalid.');
  }

  for (const record of [...rawNodes, ...rawEdges]) {
    if (isObject(record)) assertOwner(record, profileId);
  }

  const boundedWidth = dimension(width, 320, 1_600, 800);
  const boundedHeight = dimension(height, 240, 1_200, 480);
  const nodes = normalizeNodes(rawNodes, profileId, boundedWidth, boundedHeight);
  const edges = normalizeEdges(rawEdges, profileId, nodes);

  const svg = svgElement(documentPort, 'svg');
  setAttributes(svg, {
    viewBox: `0 0 ${boundedWidth} ${boundedHeight}`,
    width: '100%',
    height: '100%',
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': `Knowledge graph with ${nodes.length} memories and ${edges.length} connections`,
  });
  const edgeLayer = svgElement(documentPort, 'g');
  edgeLayer.setAttribute('class', 'knowledge-graph-edges');
  svg.appendChild(edgeLayer);
  const nodeLayer = svgElement(documentPort, 'g');
  nodeLayer.setAttribute('class', 'knowledge-graph-nodes');
  svg.appendChild(nodeLayer);

  for (const edge of edges) appendEdge(documentPort, edgeLayer, edge);
  for (const node of nodes) appendNode(documentPort, nodeLayer, node, onActivate);
  container.replaceChildren(svg);

  return Object.freeze({
    renderedNodes: nodes.length,
    renderedEdges: edges.length,
    omittedNodes: rawNodes.length - nodes.length,
    omittedEdges: rawEdges.length - edges.length,
  });
}
