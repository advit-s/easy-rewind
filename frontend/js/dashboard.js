import { createDashboardApiClient } from './api-client.js';
import { createSafeLink, createTextElement, replaceChildren } from './dom.js';
import { renderKnowledgeGraph } from './graph-renderer.js';
import { createDashboardSession } from './session.js';
import {
  createBookmarksView,
  createDigestsView,
  createHighlightsView,
  createMemoriesView,
  createNotesView,
  createRemindersView,
  createResearchView,
} from './view-models.js';

const byId = id => document.getElementById(id);
const session = createDashboardSession();
const client = createDashboardApiClient({ session });

const dom = {
  connectionPanel: byId('connection-panel'),
  connectionStatus: byId('connection-status'),
  sessionForm: byId('session-form'),
  profileId: byId('session-profile-id'),
  authorization: byId('session-authorization'),
  connect: byId('session-connect-btn'),
  disconnect: byId('session-disconnect-btn'),
  retry: byId('session-retry-btn'),
  serverDot: byId('server-dot'),
  serverLabel: byId('server-label'),
  statTotal: byId('stat-total'),
  statTopics: byId('stat-topics'),
  statWeek: byId('stat-week'),
  statLatest: byId('stat-latest'),
  search: byId('search-input'),
  sort: byId('sort-select'),
  grid: byId('grid-view-btn'),
  list: byId('list-view-btn'),
  topicPills: byId('topic-pills'),
  results: byId('results-count'),
  searchClear: byId('search-clear-btn'),
  bookmarks: byId('bookmarks-container'),
  memory: byId('memory-grid'),
  notes: byId('notes-grid'),
  research: byId('research-grid'),
  highlights: byId('highlights-grid'),
  graph: byId('kg-svg'),
  graphStatus: byId('kg-status'),
  graphDetail: byId('kg-node-detail'),
  graphTitle: byId('kg-node-title'),
  graphUrl: byId('kg-node-url'),
  graphConnections: byId('kg-node-connections'),
  digest: byId('digest-list'),
  digestEmpty: byId('digest-empty'),
  reminderSection: byId('reminder-section'),
  reminderList: byId('reminder-list'),
  reminderCount: byId('reminder-count-badge'),
  reminderDismiss: byId('reminder-dismiss-all'),
  deleteModal: byId('delete-modal'),
  deleteTitle: byId('modal-title-el'),
  deleteCancel: byId('modal-cancel-btn'),
  deleteConfirm: byId('modal-confirm-btn'),
  toast: byId('toast-container'),
};

let activeSession = null;
let bookmarkItems = [];
let visibleBookmarks = [];
let currentView = 'grid';
let currentSort = 'newest';
let currentSearch = '';
let currentTopic = 'all';
let currentPanel = 'bookmarks';
let pendingDelete = null;

class DashboardRequestFailure extends Error {
  constructor(result) {
    super(result?.error?.message ?? 'The requested dashboard operation failed.');
    this.name = 'DashboardRequestFailure';
    this.state = result?.state ?? 'failed';
  }
}

function textElement(tag, className, text = '', attributes) {
  return createTextElement(document, tag, { className, text, attributes });
}

function button(className, text, action, attributes = {}) {
  const control = textElement('button', className, text, {
    ...attributes,
    ...(action ? { 'data-action': action } : {}),
  });
  control.type = 'button';
  return control;
}

function append(parent, ...children) {
  for (const child of children) {
    if (child) parent.appendChild(child);
  }
  return parent;
}

function safeDate(value) {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function relativeTime(value) {
  const date = safeDate(value);
  if (!date) return 'Unknown time';
  const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
}

function showToast(message, type = 'info') {
  const toast = textElement('div', `toast ${type}`, message, { role: 'status' });
  dom.toast.appendChild(toast);
  globalThis.setTimeout(() => {
    toast.classList.add('toast-leaving');
    globalThis.setTimeout(() => toast.remove(), 300);
  }, 3_000);
}

function setConnectionState(state, message) {
  dom.connectionPanel.dataset.state = state;
  dom.connectionStatus.textContent = message;
  const authenticated = activeSession !== null;
  dom.sessionForm.classList.toggle('is-hidden', authenticated);
  dom.disconnect.classList.toggle('is-hidden', !authenticated);
  dom.retry.classList.toggle('is-hidden', !authenticated || !['offline', 'failed', 'partial'].includes(state));
  dom.serverDot.classList.toggle('online', state === 'connected' || state === 'partial');
  dom.serverLabel.textContent =
    state === 'connected'
      ? 'Online'
      : state === 'partial'
        ? 'Partial'
        : state === 'connecting'
          ? 'Connecting...'
          : state === 'authentication-required'
            ? 'Sign in'
            : 'Offline';
}

async function handleRequestFailure(result) {
  if (result.state === 'authentication_required') {
    await session.clear();
    activeSession = null;
    setConnectionState(
      'authentication-required',
      'Authorization expired. Re-enter the profile ID and install authorization.'
    );
  } else if (result.state === 'offline') {
    setConnectionState('offline', result.error.message);
  } else if (result.state === 'incompatible') {
    setConnectionState('failed', result.error.message);
  }
}

async function apiRequest(path, options) {
  const result = await client.request(path, options);
  if (result.state === 'ready') return result.data;
  await handleRequestFailure(result);
  throw new DashboardRequestFailure(result);
}

async function checkHealth() {
  const result = await client.request('/api/health');
  if (result.state === 'ready') {
    setConnectionState('connected', `Connected to profile ${activeSession.profileId}.`);
    return true;
  }
  await handleRequestFailure(result);
  return false;
}

function pageInput(data, key, transform = value => value) {
  const items = Array.isArray(data?.[key]) ? data[key] : Array.isArray(data?.items) ? data.items : [];
  return {
    profileId: activeSession.profileId,
    status: 'ready',
    items: items.map(transform),
    hasMore: data?.hasMore === true,
    nextCursor: data?.hasMore === true ? data?.nextCursor : null,
  };
}

function showCollectionState(container, title, message, state = 'empty') {
  const wrapper = textElement('div', `empty-state span-all collection-${state}`);
  append(wrapper, textElement('div', 'empty-title', title), textElement('div', 'empty-text', message));
  replaceChildren(container, [wrapper]);
}

function showPartial(view) {
  if (view.state !== 'partial') return null;
  setConnectionState(
    'partial',
    `Connected to profile ${activeSession.profileId}; some records were omitted or another page is available.`
  );
  return textElement(
    'div',
    'partial-state span-all',
    'Some results are not shown. Retry after checking the local backend.'
  );
}

function renderFailure(container, error, title = 'Could not load') {
  showCollectionState(container, title, error.message, error.state === 'offline' ? 'offline' : 'failed');
}

function computeBookmarkStats(items) {
  const tags = new Set(items.flatMap(item => item.tags.map(tag => tag.toLocaleLowerCase('en-US'))));
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1_000;
  const latest = items.reduce((value, item) => Math.max(value, item.createdAt ?? 0), 0);
  dom.statTotal.textContent = String(items.length);
  dom.statTopics.textContent = String(tags.size);
  dom.statWeek.textContent = String(items.filter(item => (item.createdAt ?? 0) >= weekAgo).length);
  dom.statLatest.textContent = latest > 0 ? relativeTime(latest) : '—';
}

function renderTopicPills() {
  const topics = [
    'all',
    ...new Set(
      bookmarkItems
        .flatMap(item => item.tags)
        .filter(Boolean)
        .slice(0, 19)
    ),
  ];
  const pills = topics.map(topic => {
    const pill = button(
      `topic-pill ${currentTopic === topic ? 'active' : ''}`,
      topic === 'all' ? 'All' : topic,
      'filter-topic',
      { 'data-topic': topic }
    );
    pill.setAttribute('aria-pressed', String(currentTopic === topic));
    return pill;
  });
  replaceChildren(dom.topicPills, pills);
}

function bookmarkMatches(item) {
  if (currentTopic !== 'all' && !item.tags.includes(currentTopic)) return false;
  if (!currentSearch) return true;
  const query = currentSearch.toLocaleLowerCase('en-US');
  return [item.title, item.description, item.url ?? '', ...item.tags].some(value =>
    value.toLocaleLowerCase('en-US').includes(query)
  );
}

function filterBookmarks() {
  const items = bookmarkItems.filter(bookmarkMatches);
  items.sort((left, right) => {
    if (currentSort === 'oldest') return (left.createdAt ?? 0) - (right.createdAt ?? 0);
    if (currentSort === 'alphabetical') return left.title.localeCompare(right.title);
    if (currentSort === 'topic') return (left.tags[0] ?? '').localeCompare(right.tags[0] ?? '');
    return (right.createdAt ?? 0) - (left.createdAt ?? 0);
  });
  visibleBookmarks = items;
  dom.results.textContent = `Showing ${items.length} of ${bookmarkItems.length} bookmarks`;
  dom.searchClear.classList.toggle('is-hidden', !currentSearch && currentTopic === 'all');
  renderBookmarks(items);
}

function bookmarkCard(item, index) {
  const article = textElement(
    'article',
    `${currentView === 'grid' ? 'bm-card' : 'bm-row'} stagger-${Math.min(index, 10)}`,
    '',
    { 'data-id': item.id }
  );
  const topic = textElement(
    'div',
    currentView === 'grid' ? 'bm-topic' : 'bm-row-topic',
    item.tags[0] ?? 'Uncategorized'
  );
  const information = textElement('div', currentView === 'grid' ? 'bm-card-info' : 'bm-row-info');
  append(
    information,
    createSafeLink(document, {
      text: item.title,
      url: item.url,
      className: currentView === 'grid' ? 'bm-title' : 'bm-row-title',
    }),
    textElement('div', currentView === 'grid' ? 'bm-url' : 'bm-row-url', item.url ?? 'No external URL')
  );
  if (item.description) information.appendChild(textElement('div', 'bm-notes', item.description));
  const footer = textElement('div', currentView === 'grid' ? 'bm-footer' : 'bm-row-actions');
  append(
    footer,
    textElement('span', 'bm-date', relativeTime(item.createdAt)),
    button('bm-action danger', 'Delete', 'delete-bookmark', {
      'data-id': item.id,
      'aria-label': `Delete ${item.title}`,
    })
  );
  return append(article, topic, information, footer);
}

function renderBookmarks(items) {
  if (items.length === 0) {
    showCollectionState(
      dom.bookmarks,
      currentSearch ? 'No results' : 'No bookmarks yet',
      currentSearch ? 'No bookmarks match the current search.' : 'Open the extension and save your first page.'
    );
    return;
  }
  replaceChildren(dom.bookmarks, items.map(bookmarkCard));
}

async function loadBookmarks() {
  showCollectionState(dom.bookmarks, 'Loading bookmarks...', 'Reading the authenticated profile.', 'loading');
  try {
    const data = await apiRequest('/api/bookmarks?limit=100');
    const view = createBookmarksView(
      pageInput(data, 'bookmarks', record => ({
        ...record,
        description: record.description ?? record.notes ?? '',
        tags: Array.isArray(record.tags) && record.tags.length > 0 ? record.tags : record.topic ? [record.topic] : [],
        createdAt: record.createdAt ?? record.created_at,
      }))
    );
    bookmarkItems = view.items;
    computeBookmarkStats(bookmarkItems);
    renderTopicPills();
    filterBookmarks();
    const partial = showPartial(view);
    if (partial) dom.bookmarks.appendChild(partial);
  } catch (error) {
    bookmarkItems = [];
    renderFailure(dom.bookmarks, error);
  }
}

function renderSimpleCards(container, view, createCard, emptyTitle, emptyMessage) {
  if (view.items.length === 0) {
    showCollectionState(container, emptyTitle, emptyMessage);
    return;
  }
  const cards = view.items.map(createCard);
  const partial = showPartial(view);
  if (partial) cards.push(partial);
  replaceChildren(container, cards);
}

async function loadNotes() {
  showCollectionState(dom.notes, 'Loading notes...', 'Reading the authenticated profile.', 'loading');
  try {
    const data = await apiRequest('/api/notes?limit=50');
    const view = createNotesView(
      pageInput(data, 'notes', record => ({
        ...record,
        title: record.title ?? record.source_title ?? 'Note',
        body: record.body ?? record.content ?? '',
        updatedAt: record.updatedAt ?? record.updated_at ?? record.created_at,
      }))
    );
    renderSimpleCards(
      dom.notes,
      view,
      (item, index) => {
        const card = textElement(
          'article',
          `note-card stagger-${Math.min(index, 10)}${item.completed ? ' completed' : ''}`
        );
        return append(
          card,
          textElement('h3', 'research-title', item.title),
          textElement('p', 'note-content', item.body),
          textElement('span', 'note-meta', relativeTime(item.updatedAt)),
          button('bm-action danger', 'Delete', 'delete-note', {
            'data-id': item.id,
            'aria-label': `Delete ${item.title}`,
          })
        );
      },
      'No notes yet',
      'Capture a note from the extension to see it here.'
    );
  } catch (error) {
    renderFailure(dom.notes, error);
  }
}

async function loadResearch() {
  showCollectionState(dom.research, 'Loading research...', 'Reading the authenticated profile.', 'loading');
  try {
    const data = await apiRequest('/api/research?limit=50');
    const view = createResearchView(
      pageInput(data, 'research', record => ({
        ...record,
        summary: record.summary ?? record.research_result ?? '',
        state: record.state ?? record.status ?? 'unknown',
        updatedAt: record.updatedAt ?? record.updated_at ?? record.created_at,
      }))
    );
    renderSimpleCards(
      dom.research,
      view,
      (item, index) => {
        const card = textElement('article', `research-card stagger-${Math.min(index, 10)}`);
        append(
          card,
          createSafeLink(document, {
            text: item.title,
            url: item.url,
            className: 'research-title',
          }),
          textElement('p', 'research-summary', item.summary),
          textElement('span', `status-badge ${item.state}`, item.state),
          textElement('span', 'note-meta', relativeTime(item.updatedAt))
        );
        return card;
      },
      'No research yet',
      'Research requests from the extension will appear here.'
    );
  } catch (error) {
    renderFailure(dom.research, error);
  }
}

async function loadMemory() {
  showCollectionState(dom.memory, 'Loading memories...', 'Reading the authenticated profile.', 'loading');
  try {
    const data = await apiRequest('/api/items?limit=100');
    const view = createMemoriesView(
      pageInput(data, 'items', record => ({
        ...record,
        memoryScore: record.memoryScore ?? record.memory_score ?? 0,
        createdAt: record.createdAt ?? record.created_at,
      }))
    );
    renderSimpleCards(
      dom.memory,
      view,
      (item, index) => {
        const card = textElement('article', `memory-card stagger-${Math.min(index, 10)}`);
        const scoreClass =
          item.memoryScore >= 0.7 ? 'score-high' : item.memoryScore >= 0.4 ? 'score-medium' : 'score-low';
        const score = textElement('span', 'memory-score');
        append(
          score,
          textElement('span', `memory-score-dot ${scoreClass}`),
          document.createTextNode(`${Math.round(item.memoryScore * 100)}%`)
        );
        return append(
          card,
          createSafeLink(document, { text: item.title, url: item.url, className: 'memory-title' }),
          textElement('p', 'memory-summary', item.summary),
          score,
          textElement('span', 'note-meta', relativeTime(item.createdAt)),
          button('bm-action danger', 'Delete', 'delete-memory', {
            'data-id': item.id,
            'aria-label': `Delete ${item.title}`,
          })
        );
      },
      'No memories yet',
      'Saved pages and locally captured items will appear here.'
    );
  } catch (error) {
    renderFailure(dom.memory, error);
  }
}

async function loadHighlights() {
  showCollectionState(dom.highlights, 'Loading highlights...', 'Reading the authenticated profile.', 'loading');
  try {
    const data = await apiRequest('/api/highlights?limit=50');
    const view = createHighlightsView(
      pageInput(data, 'highlights', record => ({
        ...record,
        pageTitle: record.pageTitle ?? record.page_title,
        createdAt: record.createdAt ?? record.created_at,
      }))
    );
    renderSimpleCards(
      dom.highlights,
      view,
      (item, index) => {
        const card = textElement('article', `highlight-card stagger-${Math.min(index, 10)}`);
        const heading = textElement('div', 'highlight-heading');
        append(
          heading,
          textElement('span', `highlight-color-dot highlight-${item.color}`),
          textElement('span', 'highlight-title', item.pageTitle)
        );
        return append(
          card,
          heading,
          textElement('blockquote', 'highlight-quote', item.text),
          createSafeLink(document, { text: item.url ?? 'No source URL', url: item.url, className: 'highlight-source' }),
          textElement('span', 'note-meta', relativeTime(item.createdAt)),
          button('bm-action danger', 'Delete', 'delete-highlight', {
            'data-id': item.id,
            'aria-label': `Delete highlight from ${item.pageTitle}`,
          })
        );
      },
      'No highlights yet',
      'Saved text selections will appear here.'
    );
  } catch (error) {
    renderFailure(dom.highlights, error);
  }
}

function showGraphNode(node, graphData) {
  dom.graphDetail.classList.remove('is-hidden');
  dom.graphTitle.textContent = node.title;
  replaceChildren(dom.graphUrl, [
    createSafeLink(document, { text: node.url ?? 'No external URL', url: node.url, className: 'kg-node-url' }),
  ]);
  const related = graphData.edges
    .filter(edge => {
      const source = edge.sourceId ?? edge.source_id ?? edge.source_item_id;
      const target = edge.targetId ?? edge.target_id ?? edge.target_item_id;
      return source === node.id || target === node.id;
    })
    .slice(0, 10)
    .map(edge => textElement('div', 'kg-connection', edge.relationship ?? edge.relation ?? 'Related memory'));
  if (related.length === 0) related.push(textElement('div', 'kg-connection', 'No direct connections.'));
  replaceChildren(dom.graphConnections, related);
}

async function loadGraph() {
  dom.graphStatus.textContent = 'Loading graph...';
  replaceChildren(dom.graph, []);
  try {
    const data = await apiRequest('/api/knowledge-graph');
    const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
    const edges = Array.isArray(data?.edges)
      ? data.edges.map(edge => ({
          ...edge,
          sourceId: edge.sourceId ?? edge.source_id ?? edge.source_item_id,
          targetId: edge.targetId ?? edge.target_id ?? edge.target_item_id,
        }))
      : [];
    const rendered = renderKnowledgeGraph({
      document,
      container: dom.graph,
      profileId: activeSession.profileId,
      nodes,
      edges,
      width: dom.graph.clientWidth || 800,
      height: 480,
      onActivate: node => showGraphNode(node, { nodes, edges }),
    });
    byId('kg-node-count').textContent = String(rendered.renderedNodes);
    byId('kg-edge-count').textContent = String(rendered.renderedEdges);
    byId('kg-connected-pct').textContent =
      rendered.renderedNodes === 0
        ? '0%'
        : `${Math.round((Math.min(rendered.renderedNodes, rendered.renderedEdges * 2) / rendered.renderedNodes) * 100)}%`;
    dom.graphStatus.textContent =
      rendered.renderedNodes === 0
        ? 'No memories are available for the graph.'
        : `${rendered.renderedNodes} memories and ${rendered.renderedEdges} connections.`;
    if (rendered.omittedNodes > 0 || rendered.omittedEdges > 0) {
      setConnectionState('partial', `Connected to profile ${activeSession.profileId}; part of the graph was omitted.`);
    }
  } catch (error) {
    dom.graphStatus.textContent = error.message;
    showCollectionState(dom.graph, 'Graph unavailable', error.message, 'failed');
  }
}

async function populateConnections() {
  const source = byId('conn-source');
  const target = byId('conn-target');
  replaceChildren(source, [new Option('Loading...', '')]);
  replaceChildren(target, [new Option('Loading...', '')]);
  try {
    const data = await apiRequest('/api/items?limit=200');
    const records = Array.isArray(data?.items) ? data.items : [];
    const options = records
      .filter(record => typeof record.id === 'string')
      .map(record => new Option(String(record.title ?? 'Untitled').slice(0, 80), record.id));
    replaceChildren(source, [new Option('Source', ''), ...options.map(option => option.cloneNode(true))]);
    replaceChildren(target, [new Option('Target', ''), ...options]);
  } catch (error) {
    replaceChildren(source, [new Option('Unavailable', '')]);
    replaceChildren(target, [new Option('Unavailable', '')]);
    byId('conn-status').textContent = error.message;
  }
}

async function loadDigests() {
  showCollectionState(dom.digest, 'Loading digests...', 'Reading the authenticated profile.', 'loading');
  try {
    const data = await apiRequest('/api/digest?limit=20');
    const view = createDigestsView(
      pageInput(data, 'digests', record => ({
        ...record,
        itemCount:
          record.itemCount ??
          record.item_count ??
          ['bookmark_count', 'note_count', 'highlight_count', 'flashcard_count'].reduce(
            (sum, key) => sum + (Number.isSafeInteger(record[key]) ? record[key] : 0),
            0
          ),
        createdAt: record.createdAt ?? record.created_at,
      }))
    );
    dom.digestEmpty.classList.toggle('is-hidden', view.items.length > 0);
    const cards = view.items.map(item => {
      const card = textElement('article', 'digest-card', '', { 'data-id': item.id });
      const header = button('digest-header', '', 'toggle-digest');
      append(
        header,
        textElement('span', 'digest-title', item.title),
        textElement('span', 'digest-date', relativeTime(item.createdAt)),
        textElement('span', 'digest-item-count', `${item.itemCount} items`),
        textElement('span', `digest-sent-badge ${item.state === 'ready' ? '' : 'digest-draft-badge'}`, item.state)
      );
      return append(card, header);
    });
    const partial = showPartial(view);
    if (partial) cards.push(partial);
    replaceChildren(dom.digest, cards);
  } catch (error) {
    dom.digestEmpty.classList.add('is-hidden');
    renderFailure(dom.digest, error);
  }
}

async function loadReminders() {
  try {
    const data = await apiRequest('/api/reminders?due=true&limit=20');
    const view = createRemindersView(
      pageInput(data, 'reminders', record => ({
        ...record,
        dueAt: record.dueAt ?? record.due_at,
      }))
    );
    dom.reminderSection.classList.toggle('is-hidden', view.items.length === 0);
    dom.reminderDismiss.classList.toggle('is-hidden', view.items.length <= 1);
    dom.reminderCount.textContent = String(view.items.length);
    replaceChildren(
      dom.reminderList,
      view.items.map(item => {
        const row = textElement('div', 'reminder-item', '', { 'data-id': item.id });
        const copy = textElement('div', 'reminder-body');
        append(
          copy,
          textElement('div', 'reminder-title', item.title),
          textElement('div', 'reminder-meta', item.message || relativeTime(item.dueAt))
        );
        return append(
          row,
          copy,
          button('reminder-done-btn', 'Done', 'complete-reminder', {
            'data-id': item.id,
            'aria-label': `Complete ${item.title}`,
          })
        );
      })
    );
    showPartial(view);
  } catch (error) {
    dom.reminderSection.classList.add('is-hidden');
  }
}

async function loadPanel(panel) {
  if (!activeSession) return;
  if (panel === 'bookmarks') return loadBookmarks();
  if (panel === 'memory') return loadMemory();
  if (panel === 'notes') return loadNotes();
  if (panel === 'research') return loadResearch();
  if (panel === 'highlights') return loadHighlights();
  if (panel === 'knowledge-graph') {
    await Promise.all([loadGraph(), populateConnections()]);
    return;
  }
  if (panel === 'digest') return loadDigests();
}

async function refreshAuthenticatedData() {
  if (!activeSession) return;
  setConnectionState('connecting', 'Checking the local backend...');
  if (!(await checkHealth())) return;
  await Promise.all([loadBookmarks(), loadReminders()]);
  if (currentPanel !== 'bookmarks') await loadPanel(currentPanel);
}

function openDelete(kind, id, title, path, reload) {
  pendingDelete = { kind, id, path, reload };
  dom.deleteTitle.textContent = `Delete ${title}?`;
  dom.deleteModal.classList.remove('hidden');
}

async function confirmDelete() {
  const deletion = pendingDelete;
  pendingDelete = null;
  dom.deleteModal.classList.add('hidden');
  if (!deletion) return;
  try {
    await apiRequest(deletion.path, { method: 'DELETE' });
    await deletion.reload();
    showToast(`${deletion.kind} deleted.`, 'success');
  } catch (error) {
    showToast(`${deletion.kind} was not deleted: ${error.message}`, 'error');
  }
}

function download(data, type, filename) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function exportCsv() {
  if (bookmarkItems.length === 0) {
    showToast('There are no bookmarks to export.');
    return;
  }
  const quote = value => `"${String(value).replaceAll('"', '""')}"`;
  const rows = [
    ['Title', 'URL', 'Description', 'Tags', 'Created'],
    ...bookmarkItems.map(item => [
      item.title,
      item.url ?? '',
      item.description,
      item.tags.join(', '),
      safeDate(item.createdAt)?.toISOString() ?? '',
    ]),
  ];
  download(rows.map(row => row.map(quote).join(',')).join('\n'), 'text/csv;charset=utf-8', 'easy-rewind-bookmarks.csv');
  showToast(`Exported ${bookmarkItems.length} bookmarks.`, 'success');
}

async function exportJson() {
  try {
    const data = await apiRequest('/api/export');
    download(JSON.stringify(data, null, 2), 'application/json;charset=utf-8', 'easy-rewind-export.json');
    showToast('Export created.', 'success');
  } catch (error) {
    showToast(`Export failed: ${error.message}`, 'error');
  }
}

async function importJson(file) {
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const data = await apiRequest('/api/import', {
      method: 'POST',
      body: { data: parsed.data ?? parsed },
    });
    if (data?.state === 'dry_run' || data?.requiresConfirmation === true) {
      showToast('Import dry-run is ready. Confirm the backup-first import in the desktop app.', 'info');
    } else {
      showToast('The backend did not return a confirmed import result.', 'error');
    }
  } catch (error) {
    showToast(`Import failed: ${error.message}`, 'error');
  }
}

async function completeReminder(id) {
  try {
    await apiRequest(`/api/reminders/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { reminded: true },
    });
    await loadReminders();
    showToast('Reminder completed.', 'success');
  } catch (error) {
    showToast(`Reminder was not completed: ${error.message}`, 'error');
  }
}

async function establishSession(event) {
  event.preventDefault();
  const profileId = dom.profileId.value.trim();
  const authorization = dom.authorization.value;
  dom.connect.disabled = true;
  try {
    await session.establish({ profileId, authorization });
    dom.sessionForm.reset();
    activeSession = await session.read();
    setConnectionState('connecting', 'Authorization stored for this tab session. Connecting...');
    await refreshAuthenticatedData();
  } catch {
    activeSession = null;
    setConnectionState('authentication-required', 'The profile ID or install authorization format is invalid.');
  } finally {
    dom.authorization.value = '';
    dom.connect.disabled = false;
  }
}

async function disconnectSession() {
  await session.clear();
  activeSession = null;
  bookmarkItems = [];
  visibleBookmarks = [];
  dom.sessionForm.reset();
  setConnectionState(
    'authentication-required',
    'Disconnected. Enter the profile ID and install authorization to reconnect.'
  );
  showCollectionState(dom.bookmarks, 'Authentication required', 'Connect this dashboard to load data.');
  for (const container of [dom.memory, dom.notes, dom.research, dom.highlights, dom.digest]) {
    showCollectionState(container, 'Authentication required', 'Reconnect to load this section.');
  }
  replaceChildren(dom.graph, []);
  dom.graphStatus.textContent = 'Reconnect to load the knowledge graph.';
  dom.reminderSection.classList.add('is-hidden');
}

async function handleAction(actionTarget) {
  const { action, id, topic } = actionTarget.dataset;
  if (action === 'retry-session') return refreshAuthenticatedData();
  if (action === 'disconnect-session') return disconnectSession();
  if (action === 'filter-topic') {
    currentTopic = topic;
    renderTopicPills();
    filterBookmarks();
    return;
  }
  if (action === 'delete-bookmark') {
    openDelete('Bookmark', id, 'bookmark', `/api/bookmark/${encodeURIComponent(id)}`, loadBookmarks);
    return;
  }
  if (action === 'delete-note') {
    openDelete('Note', id, 'note', `/api/notes/${encodeURIComponent(id)}`, loadNotes);
    return;
  }
  if (action === 'delete-memory') {
    openDelete('Memory', id, 'memory', `/api/items/${encodeURIComponent(id)}`, loadMemory);
    return;
  }
  if (action === 'delete-highlight') {
    openDelete('Highlight', id, 'highlight', `/api/highlights/${encodeURIComponent(id)}`, loadHighlights);
    return;
  }
  if (action === 'complete-reminder') return completeReminder(id);
  if (action === 'dismiss-reminders') {
    for (const reminder of dom.reminderList.querySelectorAll('[data-action="complete-reminder"]')) {
      await completeReminder(reminder.dataset.id);
    }
    return;
  }
  if (action === 'toggle-digest') {
    actionTarget.closest('.digest-card')?.classList.toggle('expanded');
  }
}

dom.sessionForm.addEventListener('submit', establishSession);
document.addEventListener('click', event => {
  const actionTarget = event.target.closest('[data-action]');
  if (actionTarget) void handleAction(actionTarget);
});

document.querySelectorAll('.dash-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    currentPanel = tab.dataset.tab;
    document.querySelectorAll('.dash-tab').forEach(control => {
      const selected = control === tab;
      control.classList.toggle('active', selected);
      control.setAttribute('aria-selected', String(selected));
    });
    document.querySelectorAll('.content-panel').forEach(panel => {
      panel.classList.toggle('active-panel', panel.dataset.panel === currentPanel);
    });
    void loadPanel(currentPanel);
  });
});

dom.search.addEventListener('input', () => {
  currentSearch = dom.search.value.trim();
  filterBookmarks();
});
dom.sort.addEventListener('change', () => {
  currentSort = dom.sort.value;
  filterBookmarks();
});
dom.grid.addEventListener('click', () => {
  currentView = 'grid';
  dom.bookmarks.classList.add('bookmarks-grid');
  dom.bookmarks.classList.remove('bookmarks-list');
  dom.grid.classList.add('active');
  dom.list.classList.remove('active');
  renderBookmarks(visibleBookmarks);
});
dom.list.addEventListener('click', () => {
  currentView = 'list';
  dom.bookmarks.classList.remove('bookmarks-grid');
  dom.bookmarks.classList.add('bookmarks-list');
  dom.grid.classList.remove('active');
  dom.list.classList.add('active');
  renderBookmarks(visibleBookmarks);
});
byId('clear-search-btn').addEventListener('click', () => {
  dom.search.value = '';
  currentSearch = '';
  currentTopic = 'all';
  renderTopicPills();
  filterBookmarks();
});
byId('export-csv-btn').addEventListener('click', exportCsv);
byId('export-json-btn').addEventListener('click', () => void exportJson());
byId('import-file-input').addEventListener('change', event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  void importJson(file);
});
dom.deleteCancel.addEventListener('click', () => {
  pendingDelete = null;
  dom.deleteModal.classList.add('hidden');
});
dom.deleteConfirm.addEventListener('click', () => void confirmDelete());
dom.deleteModal.addEventListener('click', event => {
  if (event.target === dom.deleteModal) {
    pendingDelete = null;
    dom.deleteModal.classList.add('hidden');
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    pendingDelete = null;
    dom.deleteModal.classList.add('hidden');
  }
});

byId('kg-discover-btn').addEventListener('click', async () => {
  const control = byId('kg-discover-btn');
  control.disabled = true;
  dom.graphStatus.textContent = 'Discovering connections...';
  try {
    await apiRequest('/api/connections/discover?limit=20', { method: 'POST' });
    await loadGraph();
    showToast('Connection discovery completed.', 'success');
  } catch (error) {
    dom.graphStatus.textContent = error.message;
    showToast(`Connection discovery failed: ${error.message}`, 'error');
  } finally {
    control.disabled = false;
  }
});

byId('conn-create-btn').addEventListener('click', async () => {
  const source = byId('conn-source').value;
  const target = byId('conn-target').value;
  const relationship = byId('conn-relationship').value;
  const status = byId('conn-status');
  if (!source || !target || source === target) {
    status.textContent = 'Select two different items.';
    return;
  }
  try {
    await apiRequest(`/api/items/${encodeURIComponent(source)}/connect`, {
      method: 'POST',
      body: { target_id: target, relationship, confidence: 0.8 },
    });
    status.textContent = 'Connected.';
    await loadGraph();
  } catch (error) {
    status.textContent = error.message;
  }
});
byId('conn-refresh-btn').addEventListener('click', () => void populateConnections());

byId('digest-generate-btn').addEventListener('click', async () => {
  const control = byId('digest-generate-btn');
  control.disabled = true;
  try {
    await apiRequest('/api/digest/generate', { method: 'POST' });
    await loadDigests();
    showToast('Digest generated.', 'success');
  } catch (error) {
    showToast(`Digest generation failed: ${error.message}`, 'error');
  } finally {
    control.disabled = false;
  }
});
byId('digest-settings-btn').addEventListener('click', async () => {
  const panel = byId('digest-settings-panel');
  panel.classList.toggle('is-hidden');
  if (panel.classList.contains('is-hidden')) return;
  try {
    const data = await apiRequest('/api/digest/settings');
    const settings = data?.settings ?? {};
    byId('digest-enabled').checked = settings.enabled !== false;
    byId('digest-freq').value = settings.frequency ?? 'weekly';
    byId('digest-day').value = String(settings.day_of_week ?? 1);
    for (const [id, key] of [
      ['digest-inc-bookmarks', 'include_bookmarks'],
      ['digest-inc-notes', 'include_notes'],
      ['digest-inc-highlights', 'include_highlights'],
      ['digest-inc-flashcards', 'include_flashcards'],
      ['digest-inc-quiz', 'include_quiz'],
      ['digest-ai-summary', 'include_ai_summary'],
    ]) {
      byId(id).checked = settings[key] !== false;
    }
  } catch (error) {
    showToast(`Digest settings failed to load: ${error.message}`, 'error');
  }
});
byId('digest-save-settings').addEventListener('click', async () => {
  try {
    await apiRequest('/api/digest/settings', {
      method: 'POST',
      body: {
        enabled: byId('digest-enabled').checked,
        frequency: byId('digest-freq').value,
        day_of_week: Number.parseInt(byId('digest-day').value, 10),
        include_bookmarks: byId('digest-inc-bookmarks').checked,
        include_notes: byId('digest-inc-notes').checked,
        include_highlights: byId('digest-inc-highlights').checked,
        include_flashcards: byId('digest-inc-flashcards').checked,
        include_quiz: byId('digest-inc-quiz').checked,
        include_ai_summary: byId('digest-ai-summary').checked,
      },
    });
    byId('digest-settings-panel').classList.add('is-hidden');
    showToast('Digest settings saved.', 'success');
  } catch (error) {
    showToast(`Digest settings were not saved: ${error.message}`, 'error');
  }
});

async function initialize() {
  activeSession = await session.read();
  if (!activeSession) {
    setConnectionState('authentication-required', 'Enter the profile ID and install authorization from Easy Rewind.');
    showCollectionState(dom.bookmarks, 'Authentication required', 'Connect this dashboard to load data.');
    return;
  }
  setConnectionState('connecting', 'Restoring the tab session...');
  await refreshAuthenticatedData();
}

void initialize();
