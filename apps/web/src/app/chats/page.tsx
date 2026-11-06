'use client';

export const dynamic = 'force-dynamic';

import { cn } from '@feed/shared';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import {
  ChatHeader,
  ChatList,
  ChatSearchBar,
  ChatView,
  useChatPage,
} from '@/components/chats';
import { CreateGroupModal } from '@/components/groups/CreateGroupModal';
import { GroupManagementModal } from '@/components/groups/GroupManagementModal';
import { useLoginModal } from '@/hooks/useLoginModal';

export default function ChatsPage() {
  const router = useRouter();
  const queueLoginModal = useLoginModal((state) => state.queueLoginModal);

  const {
    // Auth
    ready,
    authenticated,
    user,

    // UI state
    activeFilter,
    setActiveFilter,
    searchQuery,
    setSearchQuery,
    selectedChatId,
    setSelectedChatId,

    // Data
    filteredChats,
    chatDetails,

    // Loading state
    loading,
    loadingChat,
    sending,
    isLoadingMore,
    hasMore,

    // Message state
    messageInput,
    setMessageInput,
    sendError,
    sendWarning,
    sendSuccess,

    // Group modals
    isCreateGroupModalOpen,
    setIsCreateGroupModalOpen,
    isGroupManagementModalOpen,
    setIsGroupManagementModalOpen,
    selectedGroupId,
    setSelectedGroupId,
    handleGroupCreated,
    handleGroupUpdated,
    handleManageGroup,

    // SSE
    sseConnected,

    // Refs
    messagesEndRef,
    topSentinelRef,
    setRefs,

    // Reply
    replyToMessage,
    handleReplyToMessage,
    clearReplyToMessage,

    // Actions
    sendMessage,
    toggleReaction,
    loadChats,
  } = useChatPage();

  // Auth required — redirect to feed and show login
  useEffect(() => {
    if (!ready || authenticated) return;
    queueLoginModal();
    router.replace('/feed');
  }, [ready, authenticated, router, queueLoginModal]);

  if (ready && !authenticated) {
    return null;
  }

  // Show back button only on mobile/tablet (not on xl+ where both columns visible)
  const showBackButton = !!selectedChatId;

  return (
    <>
      {/* Mobile: fixed between MobileHeader (top-14) and BottomNav (--bottom-nav-height; 0 while the keyboard is open) */}
      {/* Desktop: normal flow, full viewport height */}
      <div className="fixed inset-x-0 top-14 bottom-[var(--bottom-nav-height)] z-30 flex flex-col overflow-hidden border-border md:relative md:inset-auto md:z-auto md:h-dvh lg:border-l">
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Left Column: Chat List */}
          {/* Mobile: full width when no chat selected, hidden when chat selected */}
          {/* Tablet (lg): w-80 sidebar when chat selected */}
          {/* Desktop (xl): always visible w-80 sidebar */}
          <div
            className={cn(
              'h-full min-h-0 flex-col border-border bg-background',
              selectedChatId
                ? 'hidden w-80 border-r lg:flex' // Hide on mobile, show as sidebar on lg+
                : 'flex w-full xl:w-80 xl:border-r' // Full width on mobile, sidebar width on xl
            )}
          >
            <ChatHeader
              isConnected={sseConnected}
              activeFilter={activeFilter}
              onFilterChange={setActiveFilter}
              onCreateGroup={() => setIsCreateGroupModalOpen(true)}
            />

            <ChatSearchBar value={searchQuery} onChange={setSearchQuery} />

            {/* Scrollable chat list */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <ChatList
                chats={filteredChats}
                selectedChatId={selectedChatId}
                loading={loading}
                searchQuery={searchQuery}
                activeFilter={activeFilter}
                onSelectChat={setSelectedChatId}
              />
            </div>
          </div>

          {/* Right Column: Chat View */}
          {/* Mobile/Tablet: only shown when chat selected */}
          {/* Desktop (xl): always shown */}
          <div
            className={cn(
              'h-full min-h-0 min-w-0 flex-1 bg-background',
              selectedChatId ? 'block' : 'hidden xl:block'
            )}
          >
            <ChatView
              chatDetails={chatDetails}
              currentUserId={user?.id}
              authenticated={authenticated}
              sseConnected={sseConnected}
              loading={loadingChat}
              isLoadingMore={isLoadingMore}
              hasMore={hasMore}
              messageInput={messageInput}
              sending={sending}
              sendError={sendError}
              sendWarning={sendWarning}
              sendSuccess={sendSuccess}
              showBackButton={showBackButton}
              containerRef={setRefs}
              topSentinelRef={topSentinelRef}
              messagesEndRef={messagesEndRef}
              onBack={() => setSelectedChatId(null)}
              onToggleReaction={toggleReaction}
              onManageGroup={handleManageGroup}
              onMessageChange={setMessageInput}
              onSendMessage={sendMessage}
              replyToMessage={replyToMessage}
              onReply={handleReplyToMessage}
              onDismissReply={clearReplyToMessage}
            />
          </div>
        </div>
      </div>

      {/* Group Modals */}
      <CreateGroupModal
        isOpen={isCreateGroupModalOpen}
        onClose={() => setIsCreateGroupModalOpen(false)}
        onGroupCreated={handleGroupCreated}
      />

      <GroupManagementModal
        isOpen={isGroupManagementModalOpen}
        onClose={() => {
          setIsGroupManagementModalOpen(false);
          setSelectedGroupId(null);
        }}
        groupId={selectedGroupId}
        onGroupUpdated={handleGroupUpdated}
        onGroupRemoved={() => {
          setSelectedChatId(null);
          setIsGroupManagementModalOpen(false);
          setSelectedGroupId(null);
          loadChats();
        }}
      />
    </>
  );
}
