'use strict';

const bridge = window.easyRewind;

const elements = Object.freeze({
  capturePanel: document.getElementById('capture-panel'),
  captureStatus: document.getElementById('capture-status'),
  clearResultsButton: document.getElementById('clear-results-button'),
  closeButton: document.getElementById('close-button'),
  globalStatus: document.getElementById('global-status'),
  noteInput: document.getElementById('note-input'),
  recentList: document.getElementById('recent-list'),
  recentPanel: document.getElementById('recent-panel'),
  refreshButton: document.getElementById('refresh-button'),
  saveNoteButton: document.getElementById('save-note-button'),
  searchButton: document.getElementById('search-button'),
  searchInput: document.getElementById('search-input'),
  searchResultList: document.getElementById('search-result-list'),
  searchResults: document.getElementById('search-results'),
  tabs: [...document.querySelectorAll('.mode-tab')],
});

function clear(node) {
  while (node.firstChild !== null) node.removeChild(node.firstChild);
}

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

function collection(value, ...keys) {
  if (Array.isArray(value?.items)) return value.items;
  for (const key of keys) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return [];
}

function timestamp(value) {
  const date =
    Number.isSafeInteger(value) && value >= 0
      ? new Date(value)
      : typeof value === 'string' && value.length <= 64
        ? new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z')
        : null;
  if (date === null || Number.isNaN(date.valueOf())) return '';
  const elapsed = Date.now() - date.valueOf();
  if (elapsed < 60_000) return 'Just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d ago`;
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(date);
}

function externalUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function status(element, message = '', kind = '') {
  element.textContent = message;
  element.classList.remove('error', 'success');
  if (kind !== '') element.classList.add(kind);
}

function errorMessage(result, fallback) {
  const message = result?.error?.message;
  return typeof message === 'string' && message.length <= 240 ? message : fallback;
}

async function request(path, options) {
  let result;
  try {
    result = await bridge.apiRequest(path, options);
  } catch {
    throw new Error('Easy Rewind could not reach the local backend.');
  }
  if (result?.state !== 'ready') {
    throw new Error(errorMessage(result, 'The local backend could not complete this request.'));
  }
  return result.data;
}

function card({ title, excerpt, meta, url }) {
  const safeUrl = externalUrl(url);
  const root = document.createElement(safeUrl === null ? 'article' : 'button');
  root.className = 'result-card';
  if (safeUrl !== null) {
    root.type = 'button';
    root.addEventListener('click', () => bridge.openInBrowser(safeUrl));
  }

  const titleNode = document.createElement('span');
  titleNode.className = 'result-title';
  titleNode.textContent = text(title, 'Untitled memory').slice(0, 240);
  root.appendChild(titleNode);

  if (text(excerpt) !== '') {
    const excerptNode = document.createElement('span');
    excerptNode.className = 'result-excerpt';
    excerptNode.textContent = text(excerpt).slice(0, 360);
    root.appendChild(excerptNode);
  }

  if (text(meta) !== '') {
    const metaNode = document.createElement('span');
    metaNode.className = 'result-meta';
    metaNode.textContent = text(meta).slice(0, 120);
    root.appendChild(metaNode);
  }
  return root;
}

function emptyState(message) {
  const node = document.createElement('p');
  node.className = 'empty-state';
  node.textContent = message;
  return node;
}

function itemCard(item) {
  const body = text(item?.excerpt, text(item?.body, text(item?.content)));
  return card({
    title: text(item?.title, body),
    excerpt: body,
    meta: [text(item?.kind), timestamp(item?.updatedAt ?? item?.updated_at ?? item?.created_at)]
      .filter(Boolean)
      .join(' · '),
    url: item?.url,
  });
}

function noteCard(note) {
  const body = text(note?.body, text(note?.content, 'Saved thought'));
  return card({
    title: body,
    excerpt: '',
    meta: `Thought${timestamp(note?.updatedAt ?? note?.updated_at ?? note?.created_at) ? ` · ${timestamp(note?.updatedAt ?? note?.updated_at ?? note?.created_at)}` : ''}`,
  });
}

function bookmarkCard(bookmark) {
  return card({
    title: text(bookmark?.title, text(bookmark?.topic, 'Saved bookmark')),
    excerpt: text(bookmark?.description, text(bookmark?.excerpt)),
    meta: `Bookmark${timestamp(bookmark?.createdAt ?? bookmark?.created_at) ? ` · ${timestamp(bookmark?.createdAt ?? bookmark?.created_at)}` : ''}`,
    url: bookmark?.url,
  });
}

function setBusy(button, busy, idleLabel, busyLabel) {
  button.disabled = busy;
  button.textContent = busy ? busyLabel : idleLabel;
}

async function search() {
  const query = elements.searchInput.value.trim();
  if (query === '') {
    status(elements.globalStatus, 'Enter something to search for.', 'error');
    elements.searchInput.focus();
    return;
  }

  setBusy(elements.searchButton, true, 'Search', 'Searching…');
  status(elements.globalStatus);
  elements.searchResults.hidden = false;
  clear(elements.searchResultList);
  elements.searchResultList.appendChild(emptyState('Searching your local memory…'));

  try {
    const data = await request('/api/search?q=' + encodeURIComponent(query) + '&limit=20', {
      method: 'GET',
    });
    const items = collection(data, 'results');
    clear(elements.searchResultList);
    if (items.length === 0) {
      elements.searchResultList.appendChild(emptyState('No matching memories yet.'));
    } else {
      for (const item of items.slice(0, 20)) elements.searchResultList.appendChild(itemCard(item));
    }
  } catch (error) {
    clear(elements.searchResultList);
    elements.searchResultList.appendChild(emptyState('Search is unavailable while the local backend is offline.'));
    status(elements.globalStatus, error.message, 'error');
  } finally {
    setBusy(elements.searchButton, false, 'Search', 'Searching…');
  }
}

async function saveNote() {
  const content = elements.noteInput.value.trim();
  if (content === '') {
    status(elements.captureStatus, 'Write a thought before saving.', 'error');
    elements.noteInput.focus();
    return;
  }

  setBusy(elements.saveNoteButton, true, 'Save thought', 'Saving…');
  status(elements.captureStatus);
  try {
    await request('/api/notes', {
      body: { content },
      method: 'POST',
    });
    elements.noteInput.value = '';
    status(elements.captureStatus, 'Thought saved to your local memory.', 'success');
  } catch (error) {
    status(elements.captureStatus, error.message, 'error');
  } finally {
    setBusy(elements.saveNoteButton, false, 'Save thought', 'Saving…');
  }
}

async function loadRecent() {
  clear(elements.recentList);
  elements.recentList.appendChild(emptyState('Loading recent memories…'));
  status(elements.globalStatus);
  elements.refreshButton.disabled = true;

  try {
    const [notesData, bookmarksData] = await Promise.all([
      request('/api/notes?limit=6', { method: 'GET' }),
      request('/api/bookmarks?limit=8', { method: 'GET' }),
    ]);
    const notes = collection(notesData, 'notes');
    const bookmarks = collection(bookmarksData, 'bookmarks');
    clear(elements.recentList);
    if (notes.length === 0 && bookmarks.length === 0) {
      elements.recentList.appendChild(emptyState('Nothing here yet. Capture your first thought.'));
      return;
    }
    for (const note of notes.slice(0, 6)) elements.recentList.appendChild(noteCard(note));
    for (const bookmark of bookmarks.slice(0, 8)) elements.recentList.appendChild(bookmarkCard(bookmark));
  } catch (error) {
    clear(elements.recentList);
    elements.recentList.appendChild(emptyState('Recent memories are unavailable while the local backend is offline.'));
    status(elements.globalStatus, error.message, 'error');
  } finally {
    elements.refreshButton.disabled = false;
  }
}

function activatePanel(panelId) {
  for (const tab of elements.tabs) {
    const active = tab.dataset.panel === panelId;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  elements.capturePanel.classList.toggle('active', panelId === 'capture-panel');
  elements.recentPanel.classList.toggle('active', panelId === 'recent-panel');
  if (panelId === 'capture-panel') {
    elements.noteInput.focus();
  } else {
    void loadRecent();
  }
}

elements.closeButton.addEventListener('click', () => bridge.hideOverlay());
elements.searchButton.addEventListener('click', () => void search());
elements.saveNoteButton.addEventListener('click', () => void saveNote());
elements.refreshButton.addEventListener('click', () => void loadRecent());
elements.clearResultsButton.addEventListener('click', () => {
  elements.searchResults.hidden = true;
  clear(elements.searchResultList);
  elements.searchInput.focus();
});
for (const tab of elements.tabs) {
  tab.addEventListener('click', () => activatePanel(tab.dataset.panel));
}
elements.searchInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void search();
  }
});
elements.noteInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.ctrlKey) {
    event.preventDefault();
    void saveNote();
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') bridge.hideOverlay();
});

elements.searchInput.focus();
