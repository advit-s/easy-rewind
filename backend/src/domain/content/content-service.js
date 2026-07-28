'use strict';

const { fail } = require('../domain-error');

function requireDependencies({ repository, syncRecorder } = {}) {
  if (
    repository === null ||
    typeof repository !== 'object' ||
    typeof repository.transaction !== 'function' ||
    syncRecorder === null ||
    typeof syncRecorder !== 'object' ||
    typeof syncRecorder.recordChange !== 'function'
  ) {
    fail('REPOSITORY_CONFIGURATION_INVALID');
  }
  return { repository, syncRecorder };
}

function createContentService(options) {
  const { repository, syncRecorder } = requireDependencies(options);

  function mutate({ profileId, entityType, changeKind = 'upsert' }, work) {
    return repository.transaction(() => {
      const result = work();
      syncRecorder.recordChange({
        profileId,
        entityType,
        entityId: result.id,
        changeKind,
        revision: result.revision,
        payload: changeKind === 'delete' ? null : result,
      });
      return result;
    });
  }

  function createItem({ profileId, item } = {}) {
    return mutate({ profileId, entityType: 'item' }, () => repository.insertItem({ profileId, item }));
  }

  function getItem(input) {
    return repository.getItem(input);
  }

  function listItems(input) {
    return repository.listItems(input);
  }

  function updateItem({ profileId, id, expectedRevision, patch } = {}) {
    return mutate({ profileId, entityType: 'item' }, () =>
      repository.updateItem({ profileId, id, expectedRevision, patch })
    );
  }

  function deleteItem({ profileId, id, expectedRevision } = {}) {
    return mutate({ profileId, entityType: 'item', changeKind: 'delete' }, () =>
      repository.tombstoneItem({ profileId, id, expectedRevision })
    );
  }

  function createBookmark({ profileId, itemId } = {}) {
    return mutate({ profileId, entityType: 'bookmark' }, () => repository.insertBookmark({ profileId, itemId }));
  }

  function createNote({ profileId, itemId = null, body } = {}) {
    return mutate({ profileId, entityType: 'note' }, () => repository.insertNote({ profileId, itemId, body }));
  }

  function createHighlight({ profileId, itemId, quote, prefix, suffix, color } = {}) {
    return mutate({ profileId, entityType: 'highlight' }, () =>
      repository.insertHighlight({ profileId, itemId, quote, prefix, suffix, color })
    );
  }

  function createTag({ profileId, name } = {}) {
    return mutate({ profileId, entityType: 'tag' }, () => repository.insertTag({ profileId, name }));
  }

  function tagItem({ profileId, itemId, tagId } = {}) {
    return mutate({ profileId, entityType: 'item_tag' }, () => repository.insertItemTag({ profileId, itemId, tagId }));
  }

  function deleteEntity({ profileId, entity, id, expectedRevision } = {}) {
    return mutate({ profileId, entityType: entity, changeKind: 'delete' }, () =>
      repository.tombstone({ profileId, entity, id, expectedRevision })
    );
  }

  function updateEntity({ profileId, entity, id, expectedRevision, patch } = {}) {
    return mutate({ profileId, entityType: entity }, () =>
      repository.updateEntity({ profileId, entity, id, expectedRevision, patch })
    );
  }

  return Object.freeze({
    createBookmark,
    createHighlight,
    createItem,
    createNote,
    createTag,
    deleteEntity,
    deleteItem,
    getEntity: repository.getEntity,
    getItem,
    listEntities: repository.listEntities,
    listItems,
    searchItems: repository.searchItems,
    tagItem,
    updateEntity,
    updateItem,
  });
}

module.exports = { createContentService };
