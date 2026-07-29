import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { useMobileRuntime } from '../../src/runtime/mobile-runtime.ts';
import { ActionButton } from '../../src/ui/action-button.tsx';
import { useAppTheme } from '../../src/ui/app-theme.tsx';
import { ContentCard } from '../../src/ui/content-card.tsx';
import { EmptyState } from '../../src/ui/empty-state.tsx';
import { Screen } from '../../src/ui/screen.tsx';
import { StatusPanel } from '../../src/ui/status-panel.tsx';
import { createSyncStatusModel, type MobileUiState } from '../../src/ui/sync-status.ts';

export interface HomeItemSummary {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly kind: string;
}

export interface HomeViewProps {
  readonly syncState: MobileUiState;
  readonly queuedCount?: number;
  readonly items: readonly HomeItemSummary[];
  readonly onCapture: () => void;
  readonly onOpenItem: (id: string) => void;
  readonly onOpenSettings: () => void;
  readonly onReviewConflicts: () => void;
}

export function HomeView({
  syncState,
  queuedCount,
  items,
  onCapture,
  onOpenItem,
  onOpenSettings,
  onReviewConflicts,
}: HomeViewProps) {
  const { colors } = useAppTheme();
  const status = createSyncStatusModel(syncState, { queuedCount });
  return (
    <Screen
      eyebrow="LOCAL LIBRARY"
      title="Keep learning anywhere."
      description="Everything you capture stays available on this Android device. Sync runs only with your paired PC."
      actions={
        <>
          <ActionButton
            label="Capture"
            onPress={onCapture}
            accessibilityHint="Opens a form that saves to this device first"
          />
          <ActionButton label="Settings" onPress={onOpenSettings} variant="tonal" />
        </>
      }
    >
      <StatusPanel model={status} onAction={syncState === 'conflicted' ? onReviewConflicts : undefined} />
      <View style={styles.sectionHeader}>
        <Text accessibilityRole="header" style={[styles.sectionTitle, { color: colors.text }]}>
          Recent
        </Text>
        <Text style={[styles.sectionHint, { color: colors.textMuted }]}>Stored on this device</Text>
      </View>
      {items.length === 0 ? (
        <EmptyState
          title="Your library is ready"
          message="Capture an article, note, video, or document to see it here."
          actionLabel="Capture first item"
          onAction={onCapture}
        />
      ) : (
        <View style={styles.list}>
          {items.map(item => (
            <ContentCard
              key={item.id}
              title={item.title}
              supportingText={item.summary}
              meta={item.kind.toUpperCase()}
              onPress={() => onOpenItem(item.id)}
            />
          ))}
        </View>
      )}
    </Screen>
  );
}

export default function HomeScreen() {
  const router = useRouter();
  const { runtime, status } = useMobileRuntime();
  let syncState: MobileUiState = status === 'loading' ? 'loading' : 'retry';
  let queuedCount = 0;
  let items: HomeItemSummary[] = [];
  if (status === 'ready') {
    try {
      const localStatus = runtime.localStatus();
      syncState = localStatus.syncState;
      queuedCount = localStatus.queuedCount;
      items = runtime
        .listContent('')
        .slice(0, 20)
        .map(item => ({
          id: item.id,
          title: item.title,
          summary: item.summary || item.content || 'Saved on this device.',
          kind: item.kind,
        }));
    } catch {
      syncState = 'retry';
    }
  }
  return (
    <HomeView
      syncState={syncState}
      queuedCount={queuedCount}
      items={items}
      onCapture={() => router.push('/capture')}
      onOpenItem={id => router.push({ pathname: '/item/[id]', params: { id } })}
      onOpenSettings={() => router.push('/settings')}
      onReviewConflicts={() => router.push('/conflicts')}
    />
  );
}

const styles = StyleSheet.create({
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 12,
  },
  sectionTitle: {
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '700',
  },
  sectionHint: {
    fontSize: 12,
    lineHeight: 16,
  },
  list: {
    gap: 12,
  },
});
