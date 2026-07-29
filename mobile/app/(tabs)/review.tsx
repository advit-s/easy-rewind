import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useMobileRuntime } from '../../src/runtime/mobile-runtime.ts';
import { ActionButton } from '../../src/ui/action-button.tsx';
import { useAppTheme } from '../../src/ui/app-theme.tsx';
import { EmptyState } from '../../src/ui/empty-state.tsx';
import { Screen } from '../../src/ui/screen.tsx';
import { StatusPanel } from '../../src/ui/status-panel.tsx';
import { createSyncStatusModel } from '../../src/ui/sync-status.ts';

export interface ReviewCard {
  readonly id: string;
  readonly prompt: string;
  readonly answer: string;
}

export interface ReviewViewProps {
  readonly card: ReviewCard | null;
  readonly answerVisible: boolean;
  readonly onReveal: () => void;
  readonly onRate: (rating: 'again' | 'hard' | 'good') => void;
}

export function ReviewView({ card, answerVisible, onReveal, onRate }: ReviewViewProps) {
  const { colors } = useAppTheme();
  return (
    <Screen title="Review" description="Review cards already stored on this device. Ratings are queued locally first.">
      {card === null ? (
        <EmptyState title="You are caught up" message="Your next due flashcard will appear here." />
      ) : (
        <View
          accessible
          accessibilityRole="summary"
          accessibilityLabel={`Review prompt. ${card.prompt}`}
          style={[styles.card, { backgroundColor: colors.surface }]}
        >
          <Text style={[styles.label, { color: colors.primary }]}>PROMPT</Text>
          <Text style={[styles.prompt, { color: colors.text }]}>{card.prompt}</Text>
          {answerVisible ? (
            <>
              <View style={[styles.divider, { backgroundColor: colors.outline }]} />
              <Text style={[styles.label, { color: colors.primary }]}>ANSWER</Text>
              <Text style={[styles.answer, { color: colors.text }]}>{card.answer}</Text>
              <View style={styles.actions}>
                <ActionButton label="Again" variant="outline" onPress={() => onRate('again')} />
                <ActionButton label="Hard" variant="tonal" onPress={() => onRate('hard')} />
                <ActionButton label="Good" onPress={() => onRate('good')} />
              </View>
            </>
          ) : (
            <ActionButton
              label="Show answer"
              onPress={onReveal}
              accessibilityHint="Reveals the answer without changing the review rating"
            />
          )}
        </View>
      )}
    </Screen>
  );
}

export default function ReviewScreen() {
  const [answerVisible, setAnswerVisible] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const { runtime, status } = useMobileRuntime();
  if (status !== 'ready') {
    return (
      <Screen title="Review">
        <StatusPanel model={createSyncStatusModel(status === 'loading' ? 'loading' : 'retry')} />
      </Screen>
    );
  }
  if (actionFailed) {
    return (
      <Screen title="Review">
        <StatusPanel model={createSyncStatusModel('retry')} />
      </Screen>
    );
  }
  let due;
  try {
    due = runtime.nextDueFlashcard();
  } catch {
    return (
      <Screen title="Review">
        <StatusPanel model={createSyncStatusModel('retry')} />
      </Screen>
    );
  }
  return (
    <ReviewView
      card={
        due === null
          ? null
          : {
              id: due.id,
              prompt: due.front,
              answer: due.back,
            }
      }
      answerVisible={answerVisible}
      onReveal={() => setAnswerVisible(true)}
      onRate={rating => {
        try {
          if (due !== null) runtime.rateFlashcard(due.id, rating);
          setAnswerVisible(false);
        } catch {
          setActionFailed(true);
        }
      }}
    />
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 24,
    padding: 24,
    gap: 16,
  },
  label: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  prompt: {
    fontSize: 24,
    lineHeight: 32,
    fontWeight: '700',
  },
  answer: {
    fontSize: 18,
    lineHeight: 28,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
});
