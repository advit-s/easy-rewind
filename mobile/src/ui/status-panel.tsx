import { StyleSheet, Text, View } from 'react-native';

import type { SyncStatusModel } from './sync-status.ts';
import { useAppTheme } from './app-theme.tsx';
import { ActionButton } from './action-button.tsx';

export interface StatusPanelProps {
  readonly model: SyncStatusModel;
  readonly onAction?: () => void;
}

export function StatusPanel({ model, onAction }: StatusPanelProps) {
  const { colors } = useAppTheme();
  const accent = {
    neutral: colors.outline,
    positive: colors.positive,
    caution: colors.caution,
    critical: colors.critical,
  }[model.tone];

  return (
    <View
      accessible
      accessibilityRole="summary"
      accessibilityLabel={model.accessibilityLabel}
      accessibilityLiveRegion="polite"
      style={[
        styles.panel,
        {
          backgroundColor: colors.surface,
          borderColor: accent,
        },
      ]}
    >
      <View style={styles.copy}>
        <Text style={[styles.title, { color: colors.text }]}>{model.title}</Text>
        <Text style={[styles.message, { color: colors.textMuted }]}>{model.message}</Text>
      </View>
      {model.actionLabel ? (
        <ActionButton label={model.actionLabel} onPress={onAction} disabled={onAction === undefined} variant="tonal" />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderWidth: 1,
    borderLeftWidth: 5,
    borderRadius: 20,
    padding: 18,
    gap: 14,
  },
  copy: {
    gap: 4,
  },
  title: {
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '700',
  },
  message: {
    fontSize: 14,
    lineHeight: 20,
  },
});
