import { StyleSheet, Text, View } from 'react-native';

import { useAppTheme } from './app-theme.tsx';
import { ActionButton } from './action-button.tsx';

export interface EmptyStateProps {
  readonly title: string;
  readonly message: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}

export function EmptyState({ title, message, actionLabel, onAction }: EmptyStateProps) {
  const { colors } = useAppTheme();
  return (
    <View
      accessible
      accessibilityRole="summary"
      accessibilityLabel={`${title}. ${message}`}
      style={[styles.container, { backgroundColor: colors.surface }]}
    >
      <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
      <Text style={[styles.message, { color: colors.textMuted }]}>{message}</Text>
      {actionLabel ? (
        <ActionButton label={actionLabel} onPress={onAction} disabled={onAction === undefined} variant="tonal" />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    minHeight: 160,
    borderRadius: 24,
    padding: 24,
    justifyContent: 'center',
    alignItems: 'flex-start',
    gap: 10,
  },
  title: {
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '700',
  },
  message: {
    fontSize: 15,
    lineHeight: 22,
  },
});
