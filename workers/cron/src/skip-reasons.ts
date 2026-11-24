export const cronSkipReasons: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  '/api/cron/game-tick': {
    'Game disabled via GAME_START environment variable': 'game_disabled',
    'Lock held by another process': 'lock_held',
    'No game found': 'no_game',
    'Game paused': 'game_paused',
    'Game clock already advanced': 'clock_already_advanced',
  },
  '/api/cron/markets-tick': {
    'Previous tick still running': 'previous_tick_running',
    'Game disabled': 'game_disabled',
    'Game not running': 'game_not_running',
  },
  '/api/cron/npc-tick': {
    'Previous tick still running': 'previous_tick_running',
    'Game disabled via GAME_START environment variable': 'game_disabled',
    'No continuous game found': 'no_continuous_game',
    'Game is paused': 'game_paused',
    'Inference budget exhausted or suspended':
      'inference_budget_exhausted_or_suspended',
  },
};

export function getCronSkipReason(path: string, reason: unknown) {
  if (typeof reason !== 'string' || !Object.hasOwn(cronSkipReasons, path)) {
    return undefined;
  }
  const reasons = cronSkipReasons[path];
  return reasons && Object.hasOwn(reasons, reason)
    ? reasons[reason]
    : undefined;
}
