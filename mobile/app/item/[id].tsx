import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { useMobileRuntime } from '../../src/runtime/mobile-runtime.ts';
import { ActionButton } from '../../src/ui/action-button.tsx';
import { useAppTheme } from '../../src/ui/app-theme.tsx';
import { Screen } from '../../src/ui/screen.tsx';
import { StatusPanel } from '../../src/ui/status-panel.tsx';
import { createSyncStatusModel, type MobileUiState } from '../../src/ui/sync-status.ts';

export interface ItemDetail {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly kind: string;
  readonly syncState: MobileUiState;
}

export interface ItemDetailViewProps {
  readonly item: ItemDetail | null;
  readonly onEdit?: () => void;
  readonly onDelete?: () => void;
}

export function ItemDetailView({ item, onEdit, onDelete }: ItemDetailViewProps) {
  const { colors } = useAppTheme();
  if (item === null) {
    return (
      <Screen title="Item unavailable">
        <StatusPanel model={createSyncStatusModel('retry')} />
      </Screen>
    );
  }
  return (
    <Screen
      eyebrow={item.kind.toUpperCase()}
      title={item.title}
      actions={
        <>
          <ActionButton label="Edit" onPress={onEdit} disabled={onEdit === undefined} variant="tonal" />
          <ActionButton label="Delete" onPress={onDelete} disabled={onDelete === undefined} variant="critical" />
        </>
      }
    >
      <StatusPanel model={createSyncStatusModel(item.syncState)} />
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={`Item content. ${item.content}`}
        style={[styles.content, { backgroundColor: colors.surface }]}
      >
        <Text selectable style={[styles.body, { color: colors.text }]}>
          {item.content}
        </Text>
      </View>
    </Screen>
  );
}

export default function ItemDetailScreen() {
  const router = useRouter();
  const { runtime, status } = useMobileRuntime();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  let item: ItemDetail | null = null;
  if (status === 'ready' && id !== undefined) {
    try {
      const stored = runtime.getContent(id);
      if (stored !== null) {
        item = {
          id: stored.id,
          title: stored.title,
          content: stored.content || stored.summary || 'This item has no text content.',
          kind: stored.kind,
          syncState: mapItemSyncState(stored.syncState),
        };
      }
    } catch {
      item = null;
    }
  } else if (status === 'loading' && id !== undefined) {
    item = {
      id,
      title: 'Loading item',
      content: 'Opening the copy stored on this device.',
      kind: 'item',
      syncState: 'loading',
    };
  }
  return (
    <ItemDetailView
      item={item}
      onEdit={
        status === 'ready' && id !== undefined ? () => router.push({ pathname: '/capture', params: { id } }) : undefined
      }
      onDelete={
        status === 'ready' && id !== undefined
          ? () => {
              runtime.deleteContent(id);
              router.back();
            }
          : undefined
      }
    />
  );
}

function mapItemSyncState(state: 'local_only' | 'queued' | 'synchronized' | 'conflicted' | 'failed'): MobileUiState {
  return {
    local_only: 'offline',
    queued: 'queued',
    synchronized: 'synchronized',
    conflicted: 'conflicted',
    failed: 'retry',
  }[state] as MobileUiState;
}

const styles = StyleSheet.create({
  content: {
    borderRadius: 20,
    padding: 20,
  },
  body: {
    fontSize: 17,
    lineHeight: 27,
  },
});
