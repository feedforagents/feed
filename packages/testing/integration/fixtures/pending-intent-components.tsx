/// <reference path="../../../../apps/web/src/global.d.ts" />
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PendingIntentContinuation } from '../../../../apps/web/src/components/auth/PendingIntentContinuation';
import { CommentInput } from '../../../../apps/web/src/components/interactions/CommentInput';
import { FollowButton } from '../../../../apps/web/src/components/interactions/FollowButton';
import { LikeButton } from '../../../../apps/web/src/components/interactions/LikeButton';
import { useLoginModal } from '../../../../apps/web/src/hooks/useLoginModal';
import { usePendingIntent } from '../../../../apps/web/src/hooks/usePendingIntent';
import { usePerpOpenPreview } from '../../../../apps/web/src/hooks/usePerpOpenPreview';
import {
  type PendingAction,
  savePendingIntent,
} from '../../../../apps/web/src/lib/onboarding/pending-intent';

declare global {
  interface Window {
    testAuthState: {
      authenticated: boolean;
      testSessionId: string;
      user: {
        id: string;
        username: string;
        profileComplete: boolean;
        tosAcceptedAt: string | null;
      };
    };
    testRoutes: string[];
    setPreviewSize: (size: number) => void;
    setTestAuth: (
      ownerId: string,
      sessionId: string,
      tosAcceptedAt?: string | null
    ) => void;
    startPendingAction: (action: PendingAction) => void;
    finishTestLogin: () => void;
    cancelTestLogin: () => void;
    pendingTestPhase: () => string;
    completeSocialIntent: (kind: 'like' | 'follow') => void;
  }
}
const parameters = new URLSearchParams(window.location.search);
const consumerMode = parameters.has('consumer');
const previewMode = parameters.has('preview');
window.testRoutes = [];
window.testAuthState = {
  authenticated: !consumerMode,
  testSessionId: 'steward-owner',
  user: {
    id: 'owner',
    username: 'owner',
    profileComplete: true,
    tosAcceptedAt: '2026-11-09T00:00:00.000Z',
  },
};
window.setTestAuth = (
  id,
  testSessionId,
  tosAcceptedAt = '2026-11-09T00:00:00.000Z'
) => {
  window.testAuthState = {
    authenticated: true,
    testSessionId,
    user: { id, username: id, profileComplete: true, tosAcceptedAt },
  };
  window.dispatchEvent(new Event('test-auth-change'));
};
window.startPendingAction = (action) => {
  savePendingIntent(action);
  useLoginModal.getState().showLoginModal();
};
window.finishTestLogin = () =>
  useLoginModal.getState().closeLoginModal('authenticated');
window.cancelTestLogin = () => useLoginModal.getState().closeLoginModal();
window.pendingTestPhase = () => usePendingIntent.getState().phase;
window.completeSocialIntent = (kind) => {
  usePendingIntent.getState().complete({
    action:
      kind === 'like'
        ? { kind, targetId: 'post-1', targetType: 'post', desired: true }
        : { kind, targetId: 'target', desired: true },
    accountId: 'owner',
    sessionId: 'steward-owner',
    likeCount: 7,
  });
};
function PreviewHarness() {
  const [size, setSize] = useState(100);
  window.setPreviewSize = setSize;
  const preview = usePerpOpenPreview({
    ticker: 'TEST',
    side: 'long',
    size,
    leverage: 10,
  });
  return <output id="preview">{JSON.stringify(preview)}</output>;
}
const element = document.getElementById('root');
if (!element) throw new Error('component mount missing');
createRoot(element).render(
  consumerMode ? (
    <StrictMode>
      <PendingIntentContinuation />
      <PendingIntentContinuation />
      {parameters.has('draft') && <CommentInput postId="post-1" />}
    </StrictMode>
  ) : previewMode ? (
    <PreviewHarness />
  ) : (
    <>
      <div id="like">
        <LikeButton targetId="post-1" targetType="post" initialCount={7} />
      </div>
      <div id="follow">
        <FollowButton userId="target" variant="icon" />
      </div>
    </>
  )
);
