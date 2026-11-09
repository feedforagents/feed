export type FeedTab = 'latest' | 'stories' | 'forYou' | 'following';

/** An explicit visitor choice survives sign-in; otherwise use the account default. */
export function resolveFeedTab(
  selected: FeedTab | null,
  authenticated: boolean
): FeedTab {
  return selected ?? (authenticated ? 'forYou' : 'latest');
}
