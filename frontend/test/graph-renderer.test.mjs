import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { MAX_GRAPH_EDGES, MAX_GRAPH_NODES, renderKnowledgeGraph } from '../js/graph-renderer.js';

const PROFILE_ID = 'profile-owner';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

class FakeSvgElement {
  constructor(namespace, tagName) {
    this.namespace = namespace;
    this.tagName = tagName;
    this.attributes = new Map();
    this.children = [];
    this.listeners = new Map();
    this.textContent = '';
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  dispatch(name, event = {}) {
    this.listeners.get(name)?.(event);
  }
}

class FakeContainer {
  replaceChildren(...children) {
    this.children = children;
  }
}

const fakeDocument = {
  calls: [],
  createElementNS(namespace, tagName) {
    this.calls.push([namespace, tagName]);
    return new FakeSvgElement(namespace, tagName);
  },
};

function flatten(root) {
  return [root, ...root.children.flatMap(flatten)];
}

function graphInput(overrides = {}) {
  return {
    document: fakeDocument,
    container: new FakeContainer(),
    profileId: PROFILE_ID,
    width: 800,
    height: 480,
    nodes: [
      {
        id: 'node-a',
        profileId: PROFILE_ID,
        title: '<img onerror=bad()>',
        url: 'https://example.com/a',
        x: -100,
        y: Number.POSITIVE_INFINITY,
        score: 0.8,
      },
      {
        id: 'node-b',
        profile_id: PROFILE_ID,
        title: 'Node B',
        url: 'javascript:alert(1)',
        x: 9_999,
        y: 9_999,
        score: 0.4,
      },
    ],
    edges: [
      {
        id: 'edge-a-b',
        profileId: PROFILE_ID,
        sourceId: 'node-a',
        targetId: 'node-b',
        relationship: '<script>related</script>',
        confidence: 0.7,
      },
    ],
    ...overrides,
  };
}

test('renders responsive deterministic SVG using namespace creation and text nodes', () => {
  fakeDocument.calls = [];
  const input = graphInput();
  const result = renderKnowledgeGraph(input);
  const svg = input.container.children[0];
  const elements = flatten(svg);

  assert.equal(result.renderedNodes, 2);
  assert.equal(result.renderedEdges, 1);
  assert.equal(svg.tagName, 'svg');
  assert.equal(svg.attributes.get('viewBox'), '0 0 800 480');
  assert.equal(svg.attributes.get('width'), '100%');
  assert.equal(svg.attributes.get('preserveAspectRatio'), 'xMidYMid meet');
  assert.equal(
    fakeDocument.calls.every(([namespace]) => namespace === SVG_NAMESPACE),
    true
  );
  assert.equal(elements.find(element => element.tagName === 'text').textContent, '<img onerror=bad()>');
  assert.equal(
    elements.some(element => element.tagName === 'script'),
    false
  );
});

test('coordinates, node counts, edge counts, score, and confidence stay bounded', () => {
  const nodes = Array.from({ length: MAX_GRAPH_NODES + 10 }, (_, index) => ({
    id: `node-${index}`,
    profileId: PROFILE_ID,
    title: `Node ${index}`,
    x: index % 2 === 0 ? -1e20 : 1e20,
    y: Number.NaN,
    score: 100,
  }));
  const edges = Array.from({ length: MAX_GRAPH_EDGES + 10 }, (_, index) => ({
    id: `edge-${index}`,
    profileId: PROFILE_ID,
    sourceId: `node-${index % MAX_GRAPH_NODES}`,
    targetId: `node-${(index + 1) % MAX_GRAPH_NODES}`,
    confidence: 100,
  }));
  const input = graphInput({ width: 99_999, height: 1, nodes, edges });

  const result = renderKnowledgeGraph(input);
  const svg = input.container.children[0];
  const elements = flatten(svg);
  const circles = elements.filter(element => element.tagName === 'circle');
  const lines = elements.filter(element => element.tagName === 'line');

  assert.deepEqual(result, {
    renderedNodes: MAX_GRAPH_NODES,
    renderedEdges: MAX_GRAPH_EDGES,
    omittedNodes: 10,
    omittedEdges: 10,
  });
  assert.equal(svg.attributes.get('viewBox'), '0 0 1600 240');
  for (const circle of circles) {
    assert.ok(Number(circle.attributes.get('cx')) >= 16);
    assert.ok(Number(circle.attributes.get('cx')) <= 1584);
    assert.ok(Number(circle.attributes.get('cy')) >= 16);
    assert.ok(Number(circle.attributes.get('cy')) <= 224);
    assert.ok(Number(circle.attributes.get('r')) <= 18);
  }
  for (const line of lines) {
    assert.ok(Number(line.attributes.get('stroke-width')) <= 4);
  }
});

test('cross-profile graph records fail closed before replacing the container', () => {
  for (const overrides of [
    {
      nodes: [
        {
          id: 'other',
          profileId: 'profile-other',
          title: 'Other owner',
        },
      ],
      edges: [],
    },
    {
      edges: [
        {
          id: 'other-edge',
          profileId: 'profile-other',
          sourceId: 'node-a',
          targetId: 'node-b',
        },
      ],
    },
    {
      nodes: [
        {
          id: 'contradictory',
          profileId: PROFILE_ID,
          profile_id: 'profile-other',
          title: 'Contradictory owner',
        },
      ],
      edges: [],
    },
  ]) {
    const input = graphInput(overrides);
    assert.throws(
      () => renderKnowledgeGraph(input),
      error => error.code === 'PROFILE_ISOLATION_VIOLATION'
    );
    assert.equal(input.container.children, undefined);
  }
});

test('nodes are keyboard focusable and activation exposes only safe normalized URLs', () => {
  const activations = [];
  const input = graphInput({
    onActivate(node) {
      activations.push(node);
    },
  });
  renderKnowledgeGraph(input);
  const svg = input.container.children[0];
  const elements = flatten(svg);
  const focusable = elements.filter(element => element.attributes.get('tabindex') === '0');

  assert.equal(focusable.length, 2);
  assert.equal(focusable[0].tagName, 'a');
  assert.equal(focusable[0].attributes.get('href'), 'https://example.com/a');
  assert.equal(focusable[0].attributes.get('rel'), 'noopener noreferrer');
  assert.equal(focusable[1].tagName, 'g');
  assert.equal(focusable[1].attributes.has('href'), false);

  focusable[0].dispatch('click');
  let prevented = false;
  focusable[1].dispatch('keydown', {
    key: ' ',
    preventDefault() {
      prevented = true;
    },
  });
  focusable[1].dispatch('keydown', { key: 'Escape' });

  assert.equal(prevented, true);
  assert.deepEqual(
    activations.map(node => [node.id, node.url]),
    [
      ['node-a', 'https://example.com/a'],
      ['node-b', null],
    ]
  );
});

test('edges with missing endpoints are omitted as partial data without unsafe output', () => {
  const input = graphInput({
    edges: [
      ...graphInput().edges,
      {
        id: 'missing',
        profileId: PROFILE_ID,
        sourceId: 'node-a',
        targetId: 'not-present',
      },
    ],
  });
  const result = renderKnowledgeGraph(input);

  assert.equal(result.renderedEdges, 1);
  assert.equal(result.omittedEdges, 1);
});

test('graph renderer has no parser, global DOM, animation, or timer dependency', async () => {
  const source = await readFile(new URL('../js/graph-renderer.js', import.meta.url), 'utf8');
  assert.doesNotMatch(
    source,
    /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.|globalThis|requestAnimationFrame|setTimeout|setInterval|\.animate\(/
  );
});
