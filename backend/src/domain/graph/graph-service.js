'use strict';

const { fail } = require('../domain-error');

function createGraphService({ repository, syncRecorder } = {}) {
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

  function mutate({ profileId, changeKind = 'upsert' }, work) {
    return repository.transaction(() => {
      const result = work();
      syncRecorder.recordChange({
        profileId,
        entityType: 'connection',
        entityId: result.id,
        changeKind,
        revision: result.revision,
        payload: changeKind === 'delete' ? null : result,
      });
      return result;
    });
  }

  function createConnection(input = {}) {
    return mutate({ profileId: input.profileId }, () => repository.insertConnection(input));
  }

  function updateConnection(input = {}) {
    return mutate({ profileId: input.profileId }, () => repository.updateConnection(input));
  }

  function deleteConnection(input = {}) {
    return mutate({ profileId: input.profileId, changeKind: 'delete' }, () => repository.tombstoneConnection(input));
  }

  return Object.freeze({
    createConnection,
    deleteConnection,
    getConnection: repository.getConnection,
    knowledgeGraph: repository.knowledgeGraph,
    listConnections: repository.listConnections,
    relatedItems: repository.relatedItems,
    updateConnection,
  });
}

module.exports = { createGraphService };
