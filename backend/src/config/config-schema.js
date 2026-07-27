'use strict';

const EXECUTION_MODES = Object.freeze(['production', 'standalone', 'test']);

const STORAGE_PATH_DEFAULTS = Object.freeze({
  database: Object.freeze(['database', 'easy-rewind.sqlite3']),
  settings: Object.freeze(['settings', 'settings.json']),
  runtimeState: Object.freeze(['runtime', 'state.json']),
  logs: Object.freeze(['logs']),
  exports: Object.freeze(['exports']),
  backups: Object.freeze(['backups']),
  migrationWork: Object.freeze(['migration-work']),
});

const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '::1']);

const PAIRING_POLICY_MODES = Object.freeze(['explicit-confirmation']);
const ALLOWED_SUBNET_POLICY_MODES = Object.freeze(['private-lan-only']);

const CONFIG_ERROR_MESSAGES = Object.freeze({
  CONFIG_INPUT_INVALID: 'Configuration input must be a plain object.',
  CONFIG_MODE_INVALID: 'Configuration mode must be production, standalone, or test.',
  CONFIG_STORAGE_ROOT_REQUIRED: 'A storage root is required.',
  CONFIG_STORAGE_ROOT_ABSOLUTE: 'The storage root must be an absolute path.',
  CONFIG_REPOSITORY_ROOT_ABSOLUTE: 'The repository root must be an absolute path.',
  CONFIG_TEST_STORAGE_ROOT_REQUIRED: 'Test mode requires an explicitly injected storage root.',
  CONFIG_TEST_STORAGE_ROOT_EXTERNAL: 'Test storage must be outside the repository.',
  CONFIG_TEST_STORAGE_ROOT_TEMPORARY: 'Test storage must be under the operating-system temporary directory.',
  CONFIG_PATHS_INVALID: 'Storage path overrides must be a plain object.',
  CONFIG_PATH_UNKNOWN: 'The storage path override name is not supported.',
  CONFIG_PATH_ABSOLUTE: 'Storage path overrides must be absolute paths.',
  CONFIG_PATH_ESCAPE: 'Storage paths must stay within the storage root.',
  CONFIG_STORAGE_LINKED: 'Storage paths must not traverse links or reparse points.',
  CONFIG_STORAGE_INSPECTION_FAILED: 'Storage path safety could not be verified.',
  CONFIG_APPLICATION_API_INVALID: 'Application API configuration must be a plain object.',
  CONFIG_APPLICATION_HOST_LOOPBACK: 'The application API host must be an unambiguous loopback literal.',
  CONFIG_APPLICATION_PORT_INVALID: 'The application API port is invalid for this execution mode.',
  CONFIG_APPLICATION_CREDENTIAL_REF_INVALID: 'The application API credential reference is invalid.',
  CONFIG_SCHEDULER_INVALID: 'Scheduler configuration must contain a boolean enabled flag.',
  CONFIG_TEST_SCHEDULER_ENABLED: 'Test mode does not permit enabled schedulers.',
  CONFIG_TEST_LISTENER_ENABLED: 'Test mode does not permit enabled listeners.',
  CONFIG_LAN_SYNC_INVALID: 'LAN sync configuration must be a plain object.',
  CONFIG_LAN_SYNC_INCOMPLETE: 'Enabled LAN sync requires explicit TLS, pairing, and subnet policies.',
  CONFIG_LAN_PORT_INVALID: 'The LAN sync port must be an integer from 1 through 65535.',
  CONFIG_LAN_SYNC_BOUNDARY_REUSE: 'LAN sync must not reuse application API configuration or credentials.',
});

module.exports = {
  ALLOWED_SUBNET_POLICY_MODES,
  CONFIG_ERROR_MESSAGES,
  EXECUTION_MODES,
  LOOPBACK_HOSTS,
  PAIRING_POLICY_MODES,
  STORAGE_PATH_DEFAULTS,
};
