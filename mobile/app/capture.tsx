import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { useMobileRuntime } from '../src/runtime/mobile-runtime.ts';
import { ActionButton } from '../src/ui/action-button.tsx';
import { useAppTheme } from '../src/ui/app-theme.tsx';
import { Screen } from '../src/ui/screen.tsx';
import { StatusPanel } from '../src/ui/status-panel.tsx';
import { createSyncStatusModel } from '../src/ui/sync-status.ts';

export interface CaptureDraft {
  readonly title: string;
  readonly content: string;
  readonly kind: 'item' | 'article' | 'video' | 'document';
}

export interface CaptureViewProps {
  readonly draft: CaptureDraft;
  readonly onChange: (draft: CaptureDraft) => void;
  readonly onSave?: (draft: CaptureDraft) => Promise<void>;
  readonly onCancel: () => void;
}

export function CaptureView({ draft, onChange, onSave, onCancel }: CaptureViewProps) {
  const { colors } = useAppTheme();
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const valid = draft.title.trim().length > 0 && draft.title.length <= 240;

  async function save() {
    if (!valid || onSave === undefined || saving) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      await onSave({
        ...draft,
        title: draft.title.trim(),
        content: draft.content.trim(),
      });
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen
      eyebrow="SAVES LOCALLY FIRST"
      title="Capture"
      description="Create an item on this device. Synchronization is requested only after the local write commits."
    >
      {saveFailed ? <StatusPanel model={createSyncStatusModel('retry')} /> : null}
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.text }]}>Title</Text>
        <TextInput
          accessibilityLabel="Item title"
          value={draft.title}
          onChangeText={title => onChange({ ...draft, title })}
          placeholder="What do you want to remember?"
          placeholderTextColor={colors.textMuted}
          maxLength={240}
          style={[
            styles.input,
            {
              backgroundColor: colors.surface,
              borderColor: colors.outline,
              color: colors.text,
            },
          ]}
        />
      </View>
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.text }]}>Notes</Text>
        <TextInput
          accessibilityLabel="Item notes"
          value={draft.content}
          onChangeText={content => onChange({ ...draft, content })}
          placeholder="Add a short note"
          placeholderTextColor={colors.textMuted}
          multiline
          textAlignVertical="top"
          style={[
            styles.input,
            styles.notes,
            {
              backgroundColor: colors.surface,
              borderColor: colors.outline,
              color: colors.text,
            },
          ]}
        />
      </View>
      {onSave === undefined ? (
        <Text accessibilityRole="alert" style={[styles.help, { color: colors.caution }]}>
          Local storage is not ready yet. Your text remains in this form and no success is reported.
        </Text>
      ) : null}
      <View style={styles.actions}>
        <ActionButton
          label={saving ? 'Saving on device' : 'Save on this device'}
          onPress={() => void save()}
          disabled={!valid || saving || onSave === undefined}
        />
        <ActionButton label="Cancel" onPress={onCancel} variant="text" />
      </View>
    </Screen>
  );
}

export default function CaptureScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const editId = Array.isArray(params.id) ? params.id[0] : params.id;
  const { runtime, status } = useMobileRuntime();
  const [draft, setDraft] = useState<CaptureDraft>({
    title: '',
    content: '',
    kind: 'item',
  });

  useEffect(() => {
    if (status !== 'ready' || editId === undefined) return;
    const existing = runtime.getContent(editId);
    if (existing !== null) {
      setDraft({
        title: existing.title,
        content: existing.content,
        kind: existing.kind,
      });
    }
  }, [editId, runtime, status]);

  return (
    <CaptureView
      draft={draft}
      onChange={setDraft}
      onSave={
        status === 'ready'
          ? async value => {
              if (editId === undefined) {
                runtime.createContent({
                  kind: value.kind,
                  title: value.title,
                  content: value.content,
                  summary: value.content.slice(0, 280),
                });
              } else {
                runtime.editContent(editId, {
                  kind: value.kind,
                  title: value.title,
                  content: value.content,
                  summary: value.content.slice(0, 280),
                });
              }
              router.back();
            }
          : undefined
      }
      onCancel={() => router.back()}
    />
  );
}

const styles = StyleSheet.create({
  field: {
    gap: 8,
  },
  label: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '700',
  },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    lineHeight: 24,
  },
  notes: {
    minHeight: 160,
  },
  help: {
    fontSize: 14,
    lineHeight: 20,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
});
