'use client';

import { create } from 'zustand';
import type {
  PendingAction,
  PendingIntent,
} from '@/lib/onboarding/pending-intent';

interface ContinuationState {
  intent: PendingIntent | null;
  completed: {
    action: PendingAction;
    accountId: string;
    sessionId: string;
    likeCount: number | null;
  } | null;
  clearCompleted: () => void;
  complete: (completion: NonNullable<ContinuationState['completed']>) => void;
  sessionId: string | null;
  reviewAccountId: string | null;
  review: (accountId: string) => void;
  phase: 'idle' | 'checking' | 'profile' | 'review' | 'running';
  begin: (intent: PendingIntent, sessionId: string) => boolean;
  setPhase: (phase: ContinuationState['phase']) => void;
  clear: () => void;
}
export const usePendingIntent = create<ContinuationState>((set, get) => ({
  intent: null,
  completed: null,
  clearCompleted: () => set({ completed: null }),
  complete: (completed) => set({ completed }),
  sessionId: null,
  reviewAccountId: null,
  review: (reviewAccountId) => set({ phase: 'review', reviewAccountId }),
  phase: 'idle',
  begin: (intent, sessionId) => {
    if (get().phase !== 'idle') return false;
    set({ intent, sessionId, phase: 'checking' });
    return true;
  },
  setPhase: (phase) => set({ phase }),
  clear: () =>
    set({
      intent: null,
      sessionId: null,
      reviewAccountId: null,
      phase: 'idle',
    }),
}));
