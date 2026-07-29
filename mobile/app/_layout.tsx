import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { MobileRuntimeProvider } from '../src/runtime/mobile-runtime.ts';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

export default function RootLayout() {
  return (
    <MobileRuntimeProvider>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerTitleAlign: 'left',
        }}
      >
        <Stack.Screen
          name="(tabs)"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen name="capture" options={{ title: 'Capture', presentation: 'modal' }} />
        <Stack.Screen name="item/[id]" options={{ title: 'Item' }} />
        <Stack.Screen name="conflicts" options={{ title: 'Conflicts' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
      </Stack>
    </MobileRuntimeProvider>
  );
}
