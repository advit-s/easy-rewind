import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAppTheme } from './app-theme.tsx';

export interface ContentCardProps {
  readonly title: string;
  readonly supportingText: string;
  readonly meta?: string;
  readonly onPress?: () => void;
  readonly trailing?: ReactNode;
}

export function ContentCard({ title, supportingText, meta, onPress, trailing }: ContentCardProps) {
  const { colors } = useAppTheme();
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : 'summary'}
      accessibilityLabel={`${title}. ${supportingText}`}
      accessibilityState={{ disabled: onPress === undefined }}
      disabled={onPress === undefined}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: colors.surface,
          borderColor: colors.outline,
        },
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.copy}>
        {meta ? <Text style={[styles.meta, { color: colors.primary }]}>{meta}</Text> : null}
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>
          {title}
        </Text>
        <Text style={[styles.supporting, { color: colors.textMuted }]} numberOfLines={3}>
          {supportingText}
        </Text>
      </View>
      {trailing}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    minHeight: 88,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 18,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  copy: {
    flex: 1,
    gap: 4,
  },
  meta: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  title: {
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '700',
  },
  supporting: {
    fontSize: 14,
    lineHeight: 20,
  },
  pressed: {
    opacity: 0.76,
  },
});
