export type Unsubscribe = () => void;

export interface SecureCredentialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface PinnedTransportRequest {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  expectedTlsFingerprintSha256: string;
  headers?: Readonly<Record<string, string>>;
  body?: string;
  timeoutMs?: number;
}

export interface PinnedTransportResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}

export interface PinnedTransport {
  request(request: PinnedTransportRequest): Promise<PinnedTransportResponse>;
}

export interface BackgroundTaskOptions {
  minimumIntervalMinutes: number;
  requiresNetwork: boolean;
}

export interface BackgroundScheduler {
  register(taskName: string, task: () => Promise<void>, options: BackgroundTaskOptions): Promise<void>;
  unregister(taskName: string): Promise<void>;
}

export interface LocalNotificationRequest {
  id?: string;
  title: string;
  body: string;
  triggerAtUtcMs: number;
  data?: Readonly<Record<string, string>>;
}

export interface NotificationPort {
  schedule(request: LocalNotificationRequest): Promise<string>;
  cancel(notificationId: string): Promise<void>;
}

export interface NetworkStatusSnapshot {
  connected: boolean;
  internetReachable: boolean | null;
  connectionType: 'wifi' | 'cellular' | 'ethernet' | 'unknown' | 'none';
}

export interface NetworkStatus {
  getStatus(): Promise<NetworkStatusSnapshot>;
  subscribe(listener: (status: NetworkStatusSnapshot) => void): Unsubscribe;
}

export interface Clock {
  now(): number;
}

export interface PlatformPorts {
  credentials: SecureCredentialStore;
  transport: PinnedTransport;
  scheduler: BackgroundScheduler;
  notifications: NotificationPort;
  network: NetworkStatus;
  clock: Clock;
}

export function definePlatformPorts<T extends PlatformPorts>(ports: T): T {
  return ports;
}
