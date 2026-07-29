import { StyleSheet, Text, View } from 'react-native';

import { useMobileRuntime } from '../src/runtime/mobile-runtime.ts';
import { ActionButton } from '../src/ui/action-button.tsx';
import { useAppTheme } from '../src/ui/app-theme.tsx';
import { Screen } from '../src/ui/screen.tsx';
import { StatusPanel } from '../src/ui/status-panel.tsx';
import { createSyncStatusModel, type MobileUiState } from '../src/ui/sync-status.ts';

export interface SettingsViewProps {
  readonly pairedPcName: string | null;
  readonly syncState: MobileUiState;
  readonly backgroundEnabled: boolean;
  readonly onPair?: () => void;
  readonly onSyncNow?: () => void;
  readonly onToggleBackground?: () => void;
}

function SettingsSection({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children?: React.ReactNode;
}) {
  const { colors } = useAppTheme();
  return (
    <View
      accessible
      accessibilityRole="summary"
      accessibilityLabel={`${title}. ${description}`}
      style={[styles.section, { backgroundColor: colors.surface }]}
    >
      <Text style={[styles.sectionTitle, { color: colors.text }]}>{title}</Text>
      <Text style={[styles.description, { color: colors.textMuted }]}>{description}</Text>
      {children ? <View style={styles.actions}>{children}</View> : null}
    </View>
  );
}

export function SettingsView({
  pairedPcName,
  syncState,
  backgroundEnabled,
  onPair,
  onSyncNow,
  onToggleBackground,
}: SettingsViewProps) {
  return (
    <Screen
      title="Settings"
      description="Control the paired PC, local-network synchronization, privacy, and Android background work."
    >
      <StatusPanel model={createSyncStatusModel(syncState)} />
      <SettingsSection
        title="Paired PC"
        description={
          pairedPcName
            ? `Paired with ${pairedPcName}. TLS identity pinning is required.`
            : 'No PC is paired. Pairing always requires confirmation on the PC.'
        }
      >
        <ActionButton
          label={pairedPcName ? 'Pair again' : 'Pair a PC'}
          onPress={onPair}
          disabled={onPair === undefined}
          variant="tonal"
        />
        <ActionButton
          label="Sync now"
          onPress={onSyncNow}
          disabled={pairedPcName === null || onSyncNow === undefined}
          variant="outline"
        />
      </SettingsSection>
      <SettingsSection
        title="Network"
        description="Synchronization uses the local network only when the paired PC is reachable. There is no cloud relay."
      />
      <SettingsSection
        title="Privacy"
        description="Items stay in this device database. Pairing credentials use protected Android storage and are never content fields."
      />
      <SettingsSection
        title="Background sync"
        description={
          backgroundEnabled
            ? 'Android may run best-effort sync when system conditions allow.'
            : 'Background sync is off. Foreground and manual sync remain available.'
        }
      >
        <ActionButton
          label={backgroundEnabled ? 'Turn off background sync' : 'Turn on background sync'}
          onPress={onToggleBackground}
          disabled={onToggleBackground === undefined}
          variant="outline"
        />
      </SettingsSection>
    </Screen>
  );
}

export default function SettingsScreen() {
  const { runtime, status } = useMobileRuntime();
  if (status !== 'ready') {
    return (
      <Screen title="Settings">
        <StatusPanel model={createSyncStatusModel(status === 'loading' ? 'loading' : 'retry')} />
      </Screen>
    );
  }
  try {
    const localStatus = runtime.localStatus();
    return (
      <SettingsView
        pairedPcName={localStatus.pairedPcName}
        syncState={localStatus.syncState}
        backgroundEnabled={false}
      />
    );
  } catch {
    return (
      <Screen title="Settings">
        <StatusPanel model={createSyncStatusModel('retry')} />
      </Screen>
    );
  }
}

const styles = StyleSheet.create({
  section: {
    borderRadius: 22,
    padding: 20,
    gap: 8,
  },
  sectionTitle: {
    fontSize: 20,
    lineHeight: 28,
    fontWeight: '700',
  },
  description: {
    fontSize: 15,
    lineHeight: 22,
  },
  actions: {
    marginTop: 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
});
