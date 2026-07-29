import { StyleSheet, Text, View } from 'react-native';

import { useMobileRuntime } from '../src/runtime/mobile-runtime.ts';
import { ActionButton } from '../src/ui/action-button.tsx';
import { useAppTheme } from '../src/ui/app-theme.tsx';
import { EmptyState } from '../src/ui/empty-state.tsx';
import { Screen } from '../src/ui/screen.tsx';
import { StatusPanel } from '../src/ui/status-panel.tsx';
import { createSyncStatusModel } from '../src/ui/sync-status.ts';

export interface ConflictSummary {
  readonly id: string;
  readonly title: string;
  readonly localSummary: string;
  readonly pcSummary: string;
}

export interface ConflictsViewProps {
  readonly conflicts: readonly ConflictSummary[];
  readonly onResolve: (id: string, choice: 'local' | 'pc') => void;
}

export function ConflictsView({ conflicts, onResolve }: ConflictsViewProps) {
  const { colors } = useAppTheme();
  return (
    <Screen title="Conflicts" description="Both versions stay preserved until you make an explicit choice.">
      {conflicts.length === 0 ? (
        <EmptyState title="No conflicts" message="Local and paired-PC changes currently agree." />
      ) : (
        <>
          <StatusPanel model={createSyncStatusModel('conflicted')} />
          <View style={styles.list}>
            {conflicts.map(conflict => (
              <View
                key={conflict.id}
                accessible
                accessibilityRole="summary"
                accessibilityLabel={`Conflict for ${conflict.title}`}
                style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.outline }]}
              >
                <Text style={[styles.title, { color: colors.text }]}>{conflict.title}</Text>
                <View style={styles.variant}>
                  <Text style={[styles.label, { color: colors.primary }]}>THIS DEVICE</Text>
                  <Text style={[styles.summary, { color: colors.textMuted }]}>{conflict.localSummary}</Text>
                  <ActionButton
                    label="Keep this device version"
                    onPress={() => onResolve(conflict.id, 'local')}
                    variant="tonal"
                  />
                </View>
                <View style={styles.variant}>
                  <Text style={[styles.label, { color: colors.primary }]}>PAIRED PC</Text>
                  <Text style={[styles.summary, { color: colors.textMuted }]}>{conflict.pcSummary}</Text>
                  <ActionButton
                    label="Keep paired PC version"
                    onPress={() => onResolve(conflict.id, 'pc')}
                    variant="outline"
                  />
                </View>
              </View>
            ))}
          </View>
        </>
      )}
    </Screen>
  );
}

export default function ConflictsScreen() {
  const { runtime, status } = useMobileRuntime();
  if (status !== 'ready') {
    return (
      <Screen title="Conflicts">
        <StatusPanel model={createSyncStatusModel(status === 'loading' ? 'loading' : 'retry')} />
      </Screen>
    );
  }
  try {
    const conflicts = runtime.listConflicts();
    if (conflicts.length === 0) {
      return <ConflictsView conflicts={[]} onResolve={() => undefined} />;
    }
    return (
      <Screen title="Conflicts" description="Both versions remain preserved in the local database.">
        <StatusPanel model={createSyncStatusModel('conflicted')} />
        <EmptyState
          title={`${conflicts.length} ${conflicts.length === 1 ? 'conflict' : 'conflicts'} preserved`}
          message="Resolution is unavailable until the paired sync workflow is active. No version was discarded."
        />
      </Screen>
    );
  } catch {
    return (
      <Screen title="Conflicts">
        <StatusPanel model={createSyncStatusModel('retry')} />
      </Screen>
    );
  }
}

const styles = StyleSheet.create({
  list: {
    gap: 16,
  },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 22,
    padding: 20,
    gap: 18,
  },
  title: {
    fontSize: 20,
    lineHeight: 28,
    fontWeight: '700',
  },
  variant: {
    gap: 8,
  },
  label: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  summary: {
    fontSize: 15,
    lineHeight: 22,
  },
});
