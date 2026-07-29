import { useColorScheme } from 'react-native';

export interface AppColors {
  readonly background: string;
  readonly surface: string;
  readonly surfaceVariant: string;
  readonly primary: string;
  readonly onPrimary: string;
  readonly primaryContainer: string;
  readonly onPrimaryContainer: string;
  readonly text: string;
  readonly textMuted: string;
  readonly outline: string;
  readonly positive: string;
  readonly caution: string;
  readonly critical: string;
}

const lightColors: AppColors = Object.freeze({
  background: '#F9F7FF',
  surface: '#FFFBFF',
  surfaceVariant: '#E7E0EC',
  primary: '#5C4AA6',
  onPrimary: '#FFFFFF',
  primaryContainer: '#E7DEFF',
  onPrimaryContainer: '#1B085F',
  text: '#1C1B20',
  textMuted: '#49454F',
  outline: '#79747E',
  positive: '#2E6B43',
  caution: '#7A5800',
  critical: '#BA1A1A',
});

const darkColors: AppColors = Object.freeze({
  background: '#141218',
  surface: '#1D1B20',
  surfaceVariant: '#49454F',
  primary: '#CBBEFF',
  onPrimary: '#2D1B75',
  primaryContainer: '#44348B',
  onPrimaryContainer: '#E7DEFF',
  text: '#E6E1E5',
  textMuted: '#CAC4D0',
  outline: '#938F99',
  positive: '#9DD5AE',
  caution: '#EBC66F',
  critical: '#FFB4AB',
});

export function useAppTheme(): Readonly<{ colors: AppColors; dark: boolean }> {
  const dark = useColorScheme() === 'dark';
  return Object.freeze({ colors: dark ? darkColors : lightColors, dark });
}
