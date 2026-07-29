import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function HomeScreen() {
  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom', 'left', 'right']}>
      <View
        accessible
        accessibilityRole="summary"
        accessibilityLabel="Easy Rewind mobile setup is ready"
        style={styles.card}
      >
        <Text style={styles.eyebrow}>LOCAL FIRST</Text>
        <Text style={styles.title}>Your learning library, even offline.</Text>
        <Text style={styles.body}>
          Capture and review on this Android device. Pairing and synchronization are added only through explicit,
          protected setup.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    justifyContent: 'center',
    backgroundColor: '#F8F7FF',
    padding: 24,
  },
  card: {
    gap: 12,
    borderRadius: 24,
    backgroundColor: '#FFFFFF',
    padding: 24,
  },
  eyebrow: {
    color: '#4E43A5',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.4,
  },
  title: {
    color: '#1C1B20',
    fontSize: 30,
    fontWeight: '700',
    lineHeight: 37,
  },
  body: {
    color: '#49454F',
    fontSize: 16,
    lineHeight: 24,
  },
});
