import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, type ViewStyle } from 'react-native';

import { useAppTheme } from './app-theme.tsx';

export type ActionButtonVariant = 'primary' | 'tonal' | 'outline' | 'text' | 'critical';

export interface ActionButtonProps {
  readonly label: string;
  readonly onPress?: () => void;
  readonly disabled?: boolean;
  readonly variant?: ActionButtonVariant;
  readonly icon?: ReactNode;
  readonly accessibilityHint?: string;
}

export function ActionButton({
  label,
  onPress,
  disabled = false,
  variant = 'primary',
  icon,
  accessibilityHint,
}: ActionButtonProps) {
  const { colors } = useAppTheme();
  const palette: Record<ActionButtonVariant, ViewStyle> = {
    primary: { backgroundColor: colors.primary, borderColor: colors.primary },
    tonal: {
      backgroundColor: colors.primaryContainer,
      borderColor: colors.primaryContainer,
    },
    outline: { backgroundColor: 'transparent', borderColor: colors.outline },
    text: { backgroundColor: 'transparent', borderColor: 'transparent' },
    critical: { backgroundColor: colors.critical, borderColor: colors.critical },
  };
  const foreground =
    variant === 'primary' || variant === 'critical'
      ? colors.onPrimary
      : variant === 'tonal'
        ? colors.onPrimaryContainer
        : colors.primary;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        palette[variant],
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      {icon}
      <Text style={[styles.label, { color: foreground }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 48,
    minWidth: 48,
    borderWidth: 1,
    borderRadius: 24,
    paddingHorizontal: 20,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  label: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '700',
  },
  disabled: {
    opacity: 0.42,
  },
  pressed: {
    opacity: 0.78,
  },
});
