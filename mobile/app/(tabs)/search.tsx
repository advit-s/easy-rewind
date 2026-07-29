import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { useMobileRuntime } from '../../src/runtime/mobile-runtime.ts';
import { useAppTheme } from '../../src/ui/app-theme.tsx';
import { ContentCard } from '../../src/ui/content-card.tsx';
import { EmptyState } from '../../src/ui/empty-state.tsx';
import { Screen } from '../../src/ui/screen.tsx';
import { StatusPanel } from '../../src/ui/status-panel.tsx';
import { createSyncStatusModel } from '../../src/ui/sync-status.ts';

export interface SearchResult {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly kind: string;
}

export interface SearchViewProps {
  readonly query: string;
  readonly results: readonly SearchResult[];
  readonly onQueryChange: (query: string) => void;
  readonly onOpenItem: (id: string) => void;
}

export function SearchView({ query, results, onQueryChange, onOpenItem }: SearchViewProps) {
  const { colors } = useAppTheme();
  return (
    <Screen title="Search" description="Search titles, notes, and highlights already stored on this device.">
      <TextInput
        accessibilityLabel="Search your local library"
        accessibilityRole="search"
        value={query}
        onChangeText={onQueryChange}
        placeholder="Search this device"
        placeholderTextColor={colors.textMuted}
        returnKeyType="search"
        clearButtonMode="while-editing"
        style={[
          styles.input,
          {
            backgroundColor: colors.surface,
            borderColor: colors.outline,
            color: colors.text,
          },
        ]}
      />
      {query.trim().length === 0 ? (
        <EmptyState
          title="Find something you saved"
          message="Enter a word or phrase. Search works without an internet connection."
        />
      ) : results.length === 0 ? (
        <EmptyState title="No local matches" message="Try another phrase or capture a new item." />
      ) : (
        <View style={styles.results}>
          {results.map(result => (
            <ContentCard
              key={result.id}
              title={result.title}
              supportingText={result.summary}
              meta={result.kind.toUpperCase()}
              onPress={() => onOpenItem(result.id)}
            />
          ))}
        </View>
      )}
    </Screen>
  );
}

export default function SearchScreen() {
  const [query, setQuery] = useState('');
  const router = useRouter();
  const { runtime, status } = useMobileRuntime();
  if (status !== 'ready') {
    return (
      <Screen title="Search">
        <StatusPanel model={createSyncStatusModel(status === 'loading' ? 'loading' : 'retry')} />
      </Screen>
    );
  }
  let results: SearchResult[] = [];
  try {
    results = runtime.listContent(query).map(item => ({
      id: item.id,
      title: item.title,
      summary: item.summary || item.content || 'Saved on this device.',
      kind: item.kind,
    }));
  } catch {
    return (
      <Screen title="Search">
        <StatusPanel model={createSyncStatusModel('retry')} />
      </Screen>
    );
  }
  return (
    <SearchView
      query={query}
      results={results}
      onQueryChange={setQuery}
      onOpenItem={id => router.push({ pathname: '/item/[id]', params: { id } })}
    />
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    lineHeight: 22,
  },
  results: {
    gap: 12,
  },
});
