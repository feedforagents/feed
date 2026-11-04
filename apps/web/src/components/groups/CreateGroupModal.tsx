'use client';

import { cn, GROUP_CONFIG, logger } from '@feed/shared';

import { Check, Loader2, Search, Users, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Avatar } from '@/components/shared/Avatar';
import { useAuth } from '@/hooks/useAuth';
import { useAuthStore } from '@/stores/authStore';
import { apiUrl } from '@/utils/api-url';

/**
 * Member structure for group creation modal.
 */
interface Member {
  id: string;
  displayName: string | null;
  username: string | null;
  profileImageUrl: string | null;
  type: 'user' | 'agent';
}

/**
 * Create group modal component for creating new user groups.
 *
 * Provides a form interface for creating groups with name input and
 * member selection. Searches for users.
 * Creates both group and associated chat on creation.
 *
 * Features:
 * - Group name input
 * - User search
 * - Member selection with type badges
 * - Auto-generated group names
 * - Form validation
 * - Loading states
 * - Error handling
 * - Member limit warning
 *
 * @param props - CreateGroupModal component props
 * @returns Create group modal element or null if not open
 */
interface CreateGroupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onGroupCreated: (groupId: string, chatId: string) => void;
}

export function CreateGroupModal({
  isOpen,
  onClose,
  onGroupCreated,
}: CreateGroupModalProps) {
  const { getAccessToken } = useAuth();
  const { user } = useAuthStore();
  const [groupName, setGroupName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Member[]>([]);
  const [selectedMembers, setSelectedMembers] = useState<Member[]>([]);
  const [searching, setSearching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setGroupName('');
      setSearchQuery('');
      setSearchResults([]);
      setSelectedMembers([]);
      setError(null);
    }
  }, [isOpen]);

  // Search for users
  useEffect(() => {
    if (!searchQuery.trim() || searchQuery.length < 2) {
      setSearchResults([]);
      return;
    }

    const searchMembers = async () => {
      setSearching(true);
      try {
        const token = await getAccessToken();

        const response = await fetch(
          `/api/users/search?q=${encodeURIComponent(searchQuery)}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        if (response.ok) {
          const data = await response.json();
          const results: Member[] = (data.users || []).map(
            (u: {
              id: string;
              displayName: string | null;
              username: string | null;
              profileImageUrl: string | null;
              isAgent?: boolean;
            }) => ({
              id: u.id,
              displayName: u.displayName,
              username: u.username,
              profileImageUrl: u.profileImageUrl,
              type: u.isAgent ? ('agent' as const) : ('user' as const),
            })
          );
          setSearchResults(results);
        } else {
          setSearchResults([]);
        }
      } catch (error) {
        logger.error(
          'Member search failed',
          error instanceof Error ? error : { error },
          'CreateGroupModal'
        );
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    };

    const debounce = setTimeout(searchMembers, 300);
    return () => clearTimeout(debounce);
  }, [searchQuery, getAccessToken]);

  const handleAddMember = (member: Member) => {
    if (!selectedMembers.find((m) => m.id === member.id)) {
      setSelectedMembers([...selectedMembers, member]);
    }
    setSearchQuery('');
    setSearchResults([]);
  };

  const handleRemoveMember = (memberId: string) => {
    setSelectedMembers(selectedMembers.filter((m) => m.id !== memberId));
  };

  const handleCreateGroup = async () => {
    // Generate group name if not provided
    let finalGroupName = groupName.trim();

    if (!finalGroupName) {
      // Auto-generate from members
      const memberNames = selectedMembers
        .slice(0, 2)
        .map((m) => m.displayName || m.username || 'User');
      const currentUserName = user?.displayName || user?.username || 'You';

      if (selectedMembers.length === 0) {
        setError('Please add at least one member or enter a group name');
        return;
      } else if (selectedMembers.length === 1) {
        finalGroupName = `${currentUserName}, ${memberNames[0]}`;
      } else if (selectedMembers.length === 2) {
        finalGroupName = `${currentUserName}, ${memberNames[0]}, ${memberNames[1]}`;
      } else {
        finalGroupName = `${currentUserName}, ${memberNames[0]}, ${memberNames[1]} +${selectedMembers.length - 2}`;
      }
    }

    setCreating(true);
    setError(null);

    const token = await getAccessToken();
    const requestBody = {
      name: finalGroupName,
      memberIds: selectedMembers.map((m) => m.id),
    };

    try {
      const response = await fetch(apiUrl('/api/groups'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const data = await response.json();
        setError(data.error || 'Failed to create group');
        return;
      }

      const data = await response.json();
      onGroupCreated(data.group.id, data.group.chatId);
      onClose();
    } catch (err) {
      logger.error(
        'Failed to create group',
        err instanceof Error ? err : { error: err },
        'CreateGroupModal'
      );
      setError('Network error. Please try again.');
    } finally {
      setCreating(false);
    }
  };

  if (!isOpen) return null;

  const handleClose = () => {
    if (creating) return; // Prevent closing during creation
    onClose();
  };

  const totalMemberCount = selectedMembers.length + 1; // +1 for creator

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-0 backdrop-blur-sm md:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          handleClose();
        }
      }}
    >
      <div
        className="flex h-full w-full flex-col bg-background md:h-auto md:max-h-[90vh] md:w-auto md:min-w-[480px] md:max-w-md md:rounded-xl md:border md:border-border md:shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-start justify-between border-border border-b p-6">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" />
            <h2 className="font-bold text-xl">Create New Group</h2>
          </div>
          <button
            onClick={handleClose}
            className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            disabled={creating}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {error && (
            <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 p-3">
              <p className="text-red-500 text-sm">{error}</p>
            </div>
          )}

          <div className="space-y-4">
            {/* Group Name (Optional) */}
            <div>
              <div className="mb-2 flex items-baseline justify-between">
                <label className="font-medium text-sm">
                  Group Name{' '}
                  <span className="font-normal text-muted-foreground text-xs">
                    (Optional)
                  </span>
                </label>
                {groupName && (
                  <span className="text-muted-foreground text-xs">
                    {groupName.length}/100
                  </span>
                )}
              </div>
              <input
                id="groupName"
                type="text"
                placeholder="Leave blank to auto-name from members..."
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                maxLength={100}
                className="w-full rounded-lg border border-border bg-sidebar px-4 py-3 transition-colors focus:border-primary focus:outline-none"
                disabled={creating}
              />
            </div>

            {/* Selected Members */}
            {selectedMembers.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="block font-medium text-sm">
                    Members ({totalMemberCount})
                  </label>
                  {totalMemberCount > GROUP_CONFIG.MEMBER_WARNING_THRESHOLD && (
                    <span className="text-xs text-yellow-600 dark:text-yellow-500">
                      Large group - performance may vary
                    </span>
                  )}
                </div>
                <div className="flex max-h-[120px] flex-wrap gap-2 overflow-y-auto rounded-lg border border-border bg-sidebar p-3">
                  {selectedMembers.map((member) => (
                    <div
                      key={member.id}
                      className="flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1.5"
                    >
                      <Avatar
                        id={member.id}
                        src={member.profileImageUrl || undefined}
                        name={member.username || member.displayName || '?'}
                        type="user"
                        size="sm"
                      />
                      <span className="text-sm">
                        {member.displayName || member.username || 'Unknown'}
                      </span>
                      <button
                        onClick={() => handleRemoveMember(member.id)}
                        className="ml-1 text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Add Members */}
            <div>
              <label className="mb-2 block font-medium text-sm">
                Add Members
              </label>

              {/* Search Input */}
              <div className="relative">
                <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="Search users by name..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full rounded-lg border border-border bg-sidebar py-3 pr-10 pl-9 transition-colors focus:border-primary focus:outline-none"
                />
                {searching && (
                  <Loader2 className="absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 animate-spin text-primary" />
                )}
              </div>
            </div>

            {/* Search Results */}
            {searchResults.length > 0 && (
              <div className="max-h-[200px] overflow-hidden overflow-y-auto rounded-lg border border-border">
                {searchResults.map((member) => {
                  const isSelected = selectedMembers.find(
                    (m) => m.id === member.id
                  );
                  return (
                    <button
                      key={member.id}
                      onClick={() => !isSelected && handleAddMember(member)}
                      className={cn(
                        'flex w-full items-center gap-3 p-3 text-left transition-colors',
                        isSelected
                          ? 'cursor-not-allowed bg-muted/50 opacity-50'
                          : 'hover:bg-sidebar'
                      )}
                      disabled={!!isSelected}
                    >
                      <Avatar
                        id={member.id}
                        src={member.profileImageUrl || undefined}
                        name={member.username || member.displayName || '?'}
                        type="user"
                        size="sm"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-sm">
                          {member.displayName || member.username || 'Unknown'}
                        </div>
                        {member.username && (
                          <div className="truncate text-muted-foreground text-xs">
                            @{member.username}
                          </div>
                        )}
                      </div>
                      {isSelected && (
                        <Check className="h-4 w-4 text-green-500" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {searchQuery.length >= 2 &&
              searchResults.length === 0 &&
              !searching && (
                <div className="py-4 text-center text-muted-foreground text-sm">
                  No users found
                </div>
              )}

            {!searchQuery && selectedMembers.length === 0 && (
              <div className="rounded-lg border border-border border-dashed bg-sidebar py-4 text-center text-muted-foreground text-sm">
                <p>Search for users to add to your group</p>
                <p className="mt-1 text-xs">
                  Group name will auto-generate if not specified
                </p>
              </div>
            )}
          </div>

          {/* Preview of auto-generated name */}
          {!groupName && selectedMembers.length > 0 && (
            <div className="mt-4 rounded-lg border border-blue-500/20 bg-blue-500/10 p-3">
              <p className="text-blue-700 text-xs dark:text-blue-300">
                <strong>Auto-name preview:</strong> {(() => {
                  const memberNames = selectedMembers
                    .slice(0, 2)
                    .map((m) => m.displayName || m.username || 'User');
                  const currentUserName =
                    user?.displayName || user?.username || 'You';

                  if (selectedMembers.length === 1) {
                    return `${currentUserName}, ${memberNames[0]}`;
                  } else if (selectedMembers.length === 2) {
                    return `${currentUserName}, ${memberNames[0]}, ${memberNames[1]}`;
                  } else {
                    return `${currentUserName}, ${memberNames[0]}, ${memberNames[1]} +${selectedMembers.length - 2}`;
                  }
                })()}
              </p>
            </div>
          )}

          {/* Action Button */}
          <div className="mt-6">
            <button
              onClick={handleCreateGroup}
              disabled={
                creating || (selectedMembers.length === 0 && !groupName.trim())
              }
              className={cn(
                'w-full rounded-lg px-4 py-3 font-medium transition-colors',
                'bg-primary text-primary-foreground hover:bg-primary/90',
                'disabled:cursor-not-allowed disabled:opacity-50'
              )}
            >
              {creating ? (
                <>
                  <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                `Create Group (${totalMemberCount} members)`
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
