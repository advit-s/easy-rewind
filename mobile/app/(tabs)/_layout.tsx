import { Tabs } from 'expo-router';
import { Text, type ColorValue } from 'react-native';

import { useAppTheme } from '../../src/ui/app-theme.tsx';

const tabGlyphs = Object.freeze({
  index: '⌂',
  search: '⌕',
  reminders: '◷',
  review: '✓',
});

function TabGlyph({ name, color }: { readonly name: keyof typeof tabGlyphs; readonly color: ColorValue }) {
  return (
    <Text accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ color, fontSize: 22 }}>
      {tabGlyphs[name]}
    </Text>
  );
}

export default function TabLayout() {
  const { colors } = useAppTheme();
  return (
    <Tabs
      screenOptions={{
        headerTitleAlign: 'left',
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.outline,
          minHeight: 64,
          paddingBottom: 8,
          paddingTop: 6,
        },
        tabBarLabelStyle: { fontSize: 12, fontWeight: '700' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarAccessibilityLabel: 'Home tab',
          tabBarIcon: ({ color }) => <TabGlyph name="index" color={color} />,
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: 'Search',
          tabBarAccessibilityLabel: 'Search tab',
          tabBarIcon: ({ color }) => <TabGlyph name="search" color={color} />,
        }}
      />
      <Tabs.Screen
        name="reminders"
        options={{
          title: 'Reminders',
          tabBarAccessibilityLabel: 'Reminders tab',
          tabBarIcon: ({ color }) => <TabGlyph name="reminders" color={color} />,
        }}
      />
      <Tabs.Screen
        name="review"
        options={{
          title: 'Review',
          tabBarAccessibilityLabel: 'Review tab',
          tabBarIcon: ({ color }) => <TabGlyph name="review" color={color} />,
        }}
      />
    </Tabs>
  );
}
