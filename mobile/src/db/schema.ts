export const MOBILE_SCHEMA_VERSION = 3 as const;

export const MOBILE_SCHEMA_TABLES = Object.freeze([
  'bookmarks',
  'conflicts',
  'device_metadata',
  'flashcards',
  'highlights',
  'inbox_acknowledgements',
  'item_tags',
  'items',
  'notes',
  'outbox',
  'reminders',
  'schema_migrations',
  'sync_cursor',
  'tags',
  'tombstones',
] as const);

export const MOBILE_SCHEMA_INDEXES = Object.freeze([
  'idx_mobile_bookmarks_profile_item',
  'idx_mobile_conflicts_profile_state',
  'idx_mobile_device_metadata_profile_device',
  'idx_mobile_flashcards_profile_due',
  'idx_mobile_highlights_profile_item',
  'idx_mobile_inbox_profile_change',
  'idx_mobile_item_tags_profile_item',
  'idx_mobile_item_tags_profile_tag',
  'idx_mobile_items_profile_created',
  'idx_mobile_items_profile_updated',
  'idx_mobile_notes_profile_item',
  'idx_mobile_outbox_profile_device_sequence',
  'idx_mobile_outbox_profile_state',
  'idx_mobile_reminders_profile_due',
  'idx_mobile_sync_cursor_profile_device',
  'idx_mobile_tags_profile_name',
  'idx_mobile_tombstones_profile_entity',
] as const);

export type MobileSchemaTable = (typeof MOBILE_SCHEMA_TABLES)[number];
