import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { useMobileRuntime } from '../../src/runtime/mobile-runtime.ts';
import { ContentCard } from '../../src/ui/content-card.tsx';
import { EmptyState } from '../../src/ui/empty-state.tsx';
import { Screen } from '../../src/ui/screen.tsx';
import { StatusPanel } from '../../src/ui/status-panel.tsx';
import { createSyncStatusModel } from '../../src/ui/sync-status.ts';

export interface ReminderSummary {
  readonly id: string;
  readonly itemId?: string | null;
  readonly title: string;
  readonly schedule: string;
  readonly state: 'scheduled' | 'completed' | 'dismissed' | 'cancelled';
}

export interface RemindersViewProps {
  readonly reminders: readonly ReminderSummary[];
  readonly offline: boolean;
  readonly onOpenItem?: (id: string) => void;
}

export function RemindersView({ reminders, offline, onOpenItem }: RemindersViewProps) {
  return (
    <Screen title="Reminders" description="Reminder changes stay independent on each device until synchronization.">
      {offline ? <StatusPanel model={createSyncStatusModel('offline')} /> : null}
      {reminders.length === 0 ? (
        <EmptyState title="No reminders due" message="Reminders attached to items on this device will appear here." />
      ) : (
        <View style={styles.list}>
          {reminders.map(reminder => (
            <ContentCard
              key={reminder.id}
              title={reminder.title}
              supportingText={reminder.schedule}
              meta={reminder.state.toUpperCase()}
              onPress={reminder.itemId && onOpenItem ? () => onOpenItem(reminder.itemId!) : undefined}
            />
          ))}
        </View>
      )}
    </Screen>
  );
}

export default function RemindersScreen() {
  const router = useRouter();
  const { runtime, status } = useMobileRuntime();
  if (status !== 'ready') {
    return (
      <Screen title="Reminders">
        <StatusPanel model={createSyncStatusModel(status === 'loading' ? 'loading' : 'retry')} />
      </Screen>
    );
  }
  try {
    const localStatus = runtime.localStatus();
    return (
      <RemindersView
        reminders={runtime.listReminders().map(reminder => ({
          id: reminder.id,
          itemId: reminder.itemId,
          title: reminder.title,
          schedule: new Date(reminder.dueAt).toLocaleString(),
          state: reminder.state,
        }))}
        offline={localStatus.syncState === 'offline'}
        onOpenItem={id => router.push({ pathname: '/item/[id]', params: { id } })}
      />
    );
  } catch {
    return (
      <Screen title="Reminders">
        <StatusPanel model={createSyncStatusModel('retry')} />
      </Screen>
    );
  }
}

const styles = StyleSheet.create({
  list: {
    gap: 12,
  },
});
