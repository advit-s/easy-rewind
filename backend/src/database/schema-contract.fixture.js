'use strict';

function namedIndex(name, unique, partial, ...columns) {
  return { name, unique, origin: 'c', partial, columns };
}

function automaticIndex(name, origin, ...columns) {
  return { name, unique: true, origin, partial: false, columns };
}

function foreignKey(from, table, onDelete, to = 'id') {
  return { from, table, to, onUpdate: 'NO ACTION', onDelete };
}

const expectedColumns = Object.freeze({
  bookmarks: ['id', 'profile_id', 'item_id', 'created_at', 'updated_at', 'revision', 'deleted_at'],
  browser_sessions: [
    'id',
    'profile_id',
    'credential_id',
    'origin',
    'token_hash',
    'csrf_hash',
    'state',
    'expires_at',
    'last_seen_at',
    'revoked_at',
    'created_at',
    'updated_at',
  ],
  client_credentials: [
    'id',
    'profile_id',
    'kind',
    'device_id',
    'label',
    'secret_ref',
    'secret_digest',
    'state',
    'last_used_at',
    'revoked_at',
    'created_at',
    'updated_at',
  ],
  connections: [
    'id',
    'profile_id',
    'source_item_id',
    'target_item_id',
    'relation',
    'note',
    'created_at',
    'updated_at',
    'revision',
    'deleted_at',
  ],
  diagnostics: ['id', 'profile_id', 'severity', 'code', 'details_json', 'occurred_at', 'created_at'],
  digests: [
    'id',
    'profile_id',
    'title',
    'body',
    'period_start',
    'period_end',
    'created_at',
    'updated_at',
    'revision',
    'deleted_at',
  ],
  flashcards: [
    'id',
    'profile_id',
    'item_id',
    'prompt',
    'answer',
    'state',
    'due_at',
    'interval_days',
    'ease_factor',
    'created_at',
    'updated_at',
    'revision',
    'deleted_at',
  ],
  highlights: [
    'id',
    'profile_id',
    'item_id',
    'quote',
    'prefix',
    'suffix',
    'color',
    'created_at',
    'updated_at',
    'revision',
    'deleted_at',
  ],
  item_tags: ['id', 'profile_id', 'item_id', 'tag_id', 'created_at', 'updated_at', 'revision', 'deleted_at'],
  items: [
    'id',
    'profile_id',
    'kind',
    'title',
    'url',
    'excerpt',
    'body',
    'source',
    'published_at',
    'archived_at',
    'created_at',
    'updated_at',
    'revision',
    'deleted_at',
  ],
  jobs: [
    'id',
    'profile_id',
    'kind',
    'state',
    'payload_json',
    'result_json',
    'error_code',
    'attempts',
    'max_attempts',
    'available_at',
    'locked_at',
    'locked_by',
    'started_at',
    'finished_at',
    'created_at',
    'updated_at',
  ],
  migration_runs: [
    'id',
    'profile_id',
    'from_version',
    'to_version',
    'state',
    'error_code',
    'started_at',
    'finished_at',
    'created_at',
  ],
  notes: ['id', 'profile_id', 'item_id', 'body', 'created_at', 'updated_at', 'revision', 'deleted_at'],
  pairing_challenges: [
    'id',
    'profile_id',
    'device_id',
    'challenge_digest',
    'state',
    'expires_at',
    'confirmed_at',
    'consumed_at',
    'created_at',
    'updated_at',
  ],
  profiles: ['id', 'display_name', 'timezone', 'locale', 'created_at', 'updated_at', 'revision', 'deleted_at'],
  quiz_results: [
    'id',
    'profile_id',
    'item_id',
    'quiz_kind',
    'score',
    'max_score',
    'answers_json',
    'completed_at',
    'created_at',
    'updated_at',
    'revision',
    'deleted_at',
  ],
  reminder_deliveries: [
    'id',
    'profile_id',
    'reminder_id',
    'channel',
    'state',
    'attempt_count',
    'scheduled_at',
    'delivered_at',
    'error_code',
    'created_at',
    'updated_at',
    'revision',
    'deleted_at',
  ],
  reminders: [
    'id',
    'profile_id',
    'item_id',
    'state',
    'due_at',
    'completed_at',
    'created_at',
    'updated_at',
    'revision',
    'deleted_at',
  ],
  research_jobs: [
    'id',
    'profile_id',
    'query',
    'state',
    'result_json',
    'error_code',
    'started_at',
    'finished_at',
    'created_at',
    'updated_at',
    'revision',
    'deleted_at',
  ],
  schema_migrations: ['version', 'name', 'checksum', 'applied_at'],
  settings: ['id', 'profile_id', 'key', 'value_json', 'created_at', 'updated_at', 'revision', 'deleted_at'],
  sync_changes: [
    'id',
    'profile_id',
    'operation_id',
    'sequence',
    'entity_type',
    'entity_id',
    'entity_revision',
    'change_kind',
    'payload_json',
    'created_at',
  ],
  sync_conflicts: [
    'id',
    'profile_id',
    'entity_type',
    'entity_id',
    'local_revision',
    'remote_revision',
    'local_payload_json',
    'remote_payload_json',
    'state',
    'resolved_at',
    'created_at',
    'updated_at',
  ],
  sync_cursors: ['id', 'profile_id', 'device_id', 'peer_device_id', 'last_sequence', 'created_at', 'updated_at'],
  sync_devices: [
    'id',
    'profile_id',
    'name',
    'platform',
    'state',
    'public_key',
    'paired_at',
    'last_seen_at',
    'revoked_at',
    'created_at',
    'updated_at',
    'revision',
    'deleted_at',
  ],
  sync_operations: [
    'id',
    'profile_id',
    'device_id',
    'operation_key',
    'entity_type',
    'entity_id',
    'base_revision',
    'payload_json',
    'state',
    'retry_count',
    'applied_at',
    'created_at',
    'updated_at',
  ],
  tags: ['id', 'profile_id', 'name', 'normalized_name', 'created_at', 'updated_at', 'revision', 'deleted_at'],
});

const expectedIndexes = Object.freeze({
  bookmarks: [
    namedIndex('idx_bookmarks_profile_updated', false, false, 'profile_id', 'deleted_at', 'updated_at', 'id'),
    namedIndex('uq_bookmarks_live_item', true, true, 'profile_id', 'item_id'),
    automaticIndex('sqlite_autoindex_bookmarks_1', 'pk', 'id'),
  ],
  browser_sessions: [
    namedIndex('idx_browser_sessions_profile_state', false, false, 'profile_id', 'state', 'expires_at', 'id'),
    automaticIndex('sqlite_autoindex_browser_sessions_1', 'pk', 'id'),
    automaticIndex('sqlite_autoindex_browser_sessions_2', 'u', 'token_hash'),
    automaticIndex('sqlite_autoindex_browser_sessions_3', 'u', 'csrf_hash'),
  ],
  client_credentials: [
    namedIndex('idx_client_credentials_profile_state', false, false, 'profile_id', 'state', 'kind', 'id'),
    automaticIndex('sqlite_autoindex_client_credentials_1', 'pk', 'id'),
    automaticIndex('sqlite_autoindex_client_credentials_2', 'u', 'secret_ref'),
    automaticIndex('sqlite_autoindex_client_credentials_3', 'u', 'secret_digest'),
    namedIndex('uq_client_credentials_profile_id', true, false, 'profile_id', 'id'),
  ],
  connections: [
    namedIndex(
      'idx_connections_profile_endpoints',
      false,
      false,
      'profile_id',
      'source_item_id',
      'target_item_id',
      'deleted_at',
      'relation'
    ),
    namedIndex(
      'idx_connections_profile_target',
      false,
      false,
      'profile_id',
      'target_item_id',
      'deleted_at',
      'updated_at'
    ),
    namedIndex(
      'uq_connections_live_endpoints',
      true,
      true,
      'profile_id',
      'source_item_id',
      'target_item_id',
      'relation'
    ),
    automaticIndex('sqlite_autoindex_connections_1', 'pk', 'id'),
  ],
  diagnostics: [automaticIndex('sqlite_autoindex_diagnostics_1', 'pk', 'id')],
  digests: [
    namedIndex('idx_digests_profile_period', false, false, 'profile_id', 'deleted_at', 'period_end', 'id'),
    automaticIndex('sqlite_autoindex_digests_1', 'pk', 'id'),
  ],
  flashcards: [
    namedIndex('idx_flashcards_profile_due', false, false, 'profile_id', 'state', 'deleted_at', 'due_at', 'id'),
    automaticIndex('sqlite_autoindex_flashcards_1', 'pk', 'id'),
  ],
  highlights: [
    namedIndex('idx_highlights_profile_item', false, false, 'profile_id', 'item_id', 'deleted_at', 'created_at', 'id'),
    automaticIndex('sqlite_autoindex_highlights_1', 'pk', 'id'),
  ],
  item_tags: [
    namedIndex('idx_item_tags_profile_tag', false, false, 'profile_id', 'tag_id', 'deleted_at', 'item_id'),
    namedIndex('uq_item_tags_live', true, true, 'profile_id', 'item_id', 'tag_id'),
    automaticIndex('sqlite_autoindex_item_tags_1', 'pk', 'id'),
  ],
  items: [
    namedIndex('idx_items_profile_kind', false, false, 'profile_id', 'kind', 'deleted_at', 'updated_at', 'id'),
    namedIndex('idx_items_profile_updated', false, false, 'profile_id', 'deleted_at', 'updated_at', 'id'),
    automaticIndex('sqlite_autoindex_items_1', 'pk', 'id'),
    namedIndex('uq_items_profile_id', true, false, 'profile_id', 'id'),
  ],
  jobs: [
    namedIndex(
      'idx_jobs_profile_state_available',
      false,
      false,
      'profile_id',
      'state',
      'available_at',
      'attempts',
      'id'
    ),
    automaticIndex('sqlite_autoindex_jobs_1', 'pk', 'id'),
  ],
  migration_runs: [
    namedIndex('idx_migration_runs_state', false, false, 'state', 'started_at', 'id'),
    automaticIndex('sqlite_autoindex_migration_runs_1', 'pk', 'id'),
  ],
  notes: [
    namedIndex('idx_notes_profile_item', false, false, 'profile_id', 'item_id', 'deleted_at', 'updated_at', 'id'),
    automaticIndex('sqlite_autoindex_notes_1', 'pk', 'id'),
  ],
  pairing_challenges: [
    namedIndex('idx_pairing_challenges_profile_state', false, false, 'profile_id', 'state', 'expires_at', 'id'),
    automaticIndex('sqlite_autoindex_pairing_challenges_1', 'pk', 'id'),
    automaticIndex('sqlite_autoindex_pairing_challenges_2', 'u', 'challenge_digest'),
  ],
  profiles: [automaticIndex('sqlite_autoindex_profiles_1', 'pk', 'id')],
  quiz_results: [
    namedIndex('idx_quiz_results_profile_completed', false, false, 'profile_id', 'deleted_at', 'completed_at', 'id'),
    automaticIndex('sqlite_autoindex_quiz_results_1', 'pk', 'id'),
  ],
  reminder_deliveries: [
    namedIndex(
      'idx_reminder_deliveries_pending',
      false,
      false,
      'profile_id',
      'state',
      'scheduled_at',
      'attempt_count',
      'id'
    ),
    automaticIndex('sqlite_autoindex_reminder_deliveries_1', 'pk', 'id'),
  ],
  reminders: [
    namedIndex('idx_reminders_profile_due', false, false, 'profile_id', 'state', 'deleted_at', 'due_at', 'id'),
    automaticIndex('sqlite_autoindex_reminders_1', 'pk', 'id'),
    namedIndex('uq_reminders_profile_id', true, false, 'profile_id', 'id'),
  ],
  research_jobs: [
    namedIndex(
      'idx_research_jobs_profile_state',
      false,
      false,
      'profile_id',
      'state',
      'deleted_at',
      'updated_at',
      'id'
    ),
    automaticIndex('sqlite_autoindex_research_jobs_1', 'pk', 'id'),
  ],
  schema_migrations: [automaticIndex('sqlite_autoindex_schema_migrations_1', 'u', 'name')],
  settings: [
    namedIndex('uq_settings_live_key', true, true, 'profile_id', 'key'),
    automaticIndex('sqlite_autoindex_settings_1', 'pk', 'id'),
  ],
  sync_changes: [
    namedIndex(
      'idx_sync_changes_profile_entity',
      false,
      false,
      'profile_id',
      'entity_type',
      'entity_id',
      'entity_revision'
    ),
    namedIndex('uq_sync_changes_profile_sequence', true, false, 'profile_id', 'sequence'),
    automaticIndex('sqlite_autoindex_sync_changes_1', 'pk', 'id'),
  ],
  sync_conflicts: [
    namedIndex('idx_sync_conflicts_profile_state', false, false, 'profile_id', 'state', 'updated_at', 'id'),
    namedIndex('uq_sync_conflicts_open_entity', true, true, 'profile_id', 'entity_type', 'entity_id'),
    automaticIndex('sqlite_autoindex_sync_conflicts_1', 'pk', 'id'),
  ],
  sync_cursors: [
    namedIndex(
      'idx_sync_cursors_profile_device',
      false,
      false,
      'profile_id',
      'device_id',
      'peer_device_id',
      'last_sequence'
    ),
    namedIndex('uq_sync_cursors_devices', true, false, 'profile_id', 'device_id', 'peer_device_id'),
    automaticIndex('sqlite_autoindex_sync_cursors_1', 'pk', 'id'),
  ],
  sync_devices: [
    namedIndex('idx_sync_devices_profile_state', false, false, 'profile_id', 'state', 'deleted_at', 'updated_at', 'id'),
    automaticIndex('sqlite_autoindex_sync_devices_1', 'pk', 'id'),
    namedIndex('uq_sync_devices_profile_id', true, false, 'profile_id', 'id'),
  ],
  sync_operations: [
    namedIndex('idx_sync_operations_device_state', false, false, 'device_id', 'state', 'created_at', 'id'),
    namedIndex('idx_sync_operations_profile_created', false, false, 'profile_id', 'state', 'created_at', 'id'),
    namedIndex('uq_sync_operations_profile_operation', true, false, 'profile_id', 'operation_key'),
    automaticIndex('sqlite_autoindex_sync_operations_1', 'pk', 'id'),
    namedIndex('uq_sync_operations_profile_id', true, false, 'profile_id', 'id'),
  ],
  tags: [
    namedIndex('idx_tags_profile_name', false, false, 'profile_id', 'deleted_at', 'normalized_name', 'id'),
    namedIndex('uq_tags_live_name', true, true, 'profile_id', 'normalized_name'),
    automaticIndex('sqlite_autoindex_tags_1', 'pk', 'id'),
    namedIndex('uq_tags_profile_id', true, false, 'profile_id', 'id'),
  ],
});

const profileCascade = foreignKey('profile_id', 'profiles', 'CASCADE');
const expectedForeignKeys = Object.freeze({
  bookmarks: [
    foreignKey('item_id', 'items', 'CASCADE'),
    foreignKey('profile_id', 'items', 'CASCADE', 'profile_id'),
    profileCascade,
  ],
  browser_sessions: [
    foreignKey('credential_id', 'client_credentials', 'CASCADE'),
    foreignKey('profile_id', 'client_credentials', 'CASCADE', 'profile_id'),
    profileCascade,
  ],
  client_credentials: [
    foreignKey('device_id', 'sync_devices', 'CASCADE'),
    foreignKey('profile_id', 'sync_devices', 'CASCADE', 'profile_id'),
    profileCascade,
  ],
  connections: [
    foreignKey('profile_id', 'items', 'CASCADE', 'profile_id'),
    foreignKey('profile_id', 'items', 'CASCADE', 'profile_id'),
    profileCascade,
    foreignKey('source_item_id', 'items', 'CASCADE'),
    foreignKey('target_item_id', 'items', 'CASCADE'),
  ],
  diagnostics: [profileCascade],
  digests: [profileCascade],
  flashcards: [
    foreignKey('item_id', 'items', 'CASCADE'),
    foreignKey('profile_id', 'items', 'CASCADE', 'profile_id'),
    profileCascade,
  ],
  highlights: [
    foreignKey('item_id', 'items', 'CASCADE'),
    foreignKey('profile_id', 'items', 'CASCADE', 'profile_id'),
    profileCascade,
  ],
  item_tags: [
    foreignKey('item_id', 'items', 'CASCADE'),
    foreignKey('profile_id', 'tags', 'CASCADE', 'profile_id'),
    foreignKey('profile_id', 'items', 'CASCADE', 'profile_id'),
    profileCascade,
    foreignKey('tag_id', 'tags', 'CASCADE'),
  ],
  items: [profileCascade],
  jobs: [profileCascade],
  migration_runs: [foreignKey('profile_id', 'profiles', 'SET NULL')],
  notes: [
    foreignKey('item_id', 'items', 'CASCADE'),
    foreignKey('profile_id', 'items', 'CASCADE', 'profile_id'),
    profileCascade,
  ],
  pairing_challenges: [
    foreignKey('device_id', 'sync_devices', 'CASCADE'),
    foreignKey('profile_id', 'sync_devices', 'CASCADE', 'profile_id'),
    profileCascade,
  ],
  profiles: [],
  quiz_results: [
    foreignKey('item_id', 'items', 'CASCADE'),
    foreignKey('profile_id', 'items', 'CASCADE', 'profile_id'),
    profileCascade,
  ],
  reminder_deliveries: [
    foreignKey('profile_id', 'reminders', 'CASCADE', 'profile_id'),
    profileCascade,
    foreignKey('reminder_id', 'reminders', 'CASCADE'),
  ],
  reminders: [
    foreignKey('item_id', 'items', 'CASCADE'),
    foreignKey('profile_id', 'items', 'CASCADE', 'profile_id'),
    profileCascade,
  ],
  research_jobs: [profileCascade],
  schema_migrations: [],
  settings: [profileCascade],
  sync_changes: [
    foreignKey('operation_id', 'sync_operations', 'NO ACTION'),
    foreignKey('operation_id', 'sync_operations', 'SET NULL'),
    foreignKey('profile_id', 'sync_operations', 'NO ACTION', 'profile_id'),
    profileCascade,
  ],
  sync_conflicts: [profileCascade],
  sync_cursors: [
    foreignKey('device_id', 'sync_devices', 'CASCADE'),
    foreignKey('peer_device_id', 'sync_devices', 'CASCADE'),
    foreignKey('profile_id', 'sync_devices', 'CASCADE', 'profile_id'),
    foreignKey('profile_id', 'sync_devices', 'CASCADE', 'profile_id'),
    profileCascade,
  ],
  sync_devices: [profileCascade],
  sync_operations: [
    foreignKey('device_id', 'sync_devices', 'NO ACTION'),
    foreignKey('device_id', 'sync_devices', 'SET NULL'),
    foreignKey('profile_id', 'sync_devices', 'NO ACTION', 'profile_id'),
    profileCascade,
  ],
  tags: [profileCascade],
});

const expectedFtsContract = Object.freeze({
  publicColumns: ['item_id', 'profile_id', 'title', 'excerpt', 'body'],
  shadowTables: ['items_fts_config', 'items_fts_content', 'items_fts_data', 'items_fts_docsize', 'items_fts_idx'],
});

const expectedMigrationMetadata = Object.freeze([
  { name: 'version', type: 'INTEGER', notnull: 0, pk: 1 },
  { name: 'name', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'checksum', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'applied_at', type: 'INTEGER', notnull: 1, pk: 0 },
]);
const descendingIndexTerms = Object.freeze({
  idx_bookmarks_profile_updated: ['updated_at'],
  idx_connections_profile_target: ['updated_at'],
  idx_digests_profile_period: ['period_end'],
  idx_items_profile_kind: ['updated_at'],
  idx_items_profile_updated: ['updated_at'],
  idx_notes_profile_item: ['updated_at'],
  idx_quiz_results_profile_completed: ['completed_at'],
  idx_sync_changes_profile_entity: ['entity_revision'],
  idx_sync_devices_profile_state: ['updated_at'],
});

const partialIndexPredicates = Object.freeze({
  uq_bookmarks_live_item: 'deleted_at IS NULL',
  uq_connections_live_endpoints: 'deleted_at IS NULL',
  uq_item_tags_live: 'deleted_at IS NULL',
  uq_settings_live_key: 'deleted_at IS NULL',
  uq_sync_conflicts_open_entity: "state = 'open'",
  uq_tags_live_name: 'deleted_at IS NULL',
});

function expectedIndexDetail(table, index) {
  const descending = new Set(descendingIndexTerms[index.name] ?? []);
  const terms = index.columns.map(name => ({
    name,
    collation: 'BINARY',
    descending: descending.has(name),
    key: true,
  }));
  terms.push({ name: null, collation: 'BINARY', descending: false, key: false });

  let sql = null;
  if (index.origin === 'c') {
    const columns = index.columns.map(name => `${name}${descending.has(name) ? ' DESC' : ''}`).join(', ');
    const predicate = partialIndexPredicates[index.name];
    sql = `CREATE${index.unique ? ' UNIQUE' : ''} INDEX ${index.name} ON ${table}(${columns})${
      predicate === undefined ? '' : ` WHERE ${predicate}`
    }`;
  }
  return { sql, terms };
}

const expectedIndexDetails = Object.freeze(
  Object.fromEntries(
    Object.entries(expectedIndexes).flatMap(([table, indexes]) =>
      indexes.map(index => [index.name, expectedIndexDetail(table, index)])
    )
  )
);

module.exports = {
  expectedColumns,
  expectedForeignKeys,
  expectedFtsContract,
  expectedIndexes,
  expectedIndexDetails,
  expectedMigrationMetadata,
};
