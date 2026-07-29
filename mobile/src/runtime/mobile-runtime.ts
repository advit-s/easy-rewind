import {
  createElement,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { createMobileRuntime, type MobileRuntime, type MobileRuntimeSnapshot } from './mobile-runtime-core.ts';

export * from './mobile-runtime-core.ts';

export interface MobileRuntimeContextValue extends MobileRuntimeSnapshot {
  readonly runtime: MobileRuntime;
}

const MobileRuntimeContext = createContext<MobileRuntimeContextValue | null>(null);

export function MobileRuntimeProvider({
  children,
  runtime: injectedRuntime,
}: {
  readonly children: ReactNode;
  readonly runtime?: MobileRuntime;
}) {
  const [runtime] = useState(() => injectedRuntime ?? createMobileRuntime());
  const ownsRuntime = injectedRuntime === undefined;
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.snapshot, runtime.snapshot);

  useEffect(() => {
    void runtime.initialize();
    if (!ownsRuntime) return undefined;
    return () => runtime.dispose();
  }, [ownsRuntime, runtime]);

  const value = useMemo(
    () =>
      Object.freeze({
        runtime,
        ...snapshot,
      }),
    [runtime, snapshot]
  );
  return createElement(MobileRuntimeContext.Provider, { value }, children);
}

export function useMobileRuntime(): MobileRuntimeContextValue {
  const value = useContext(MobileRuntimeContext);
  if (value === null) {
    throw new Error('MobileRuntimeProvider is required.');
  }
  return value;
}
