CREATE TABLE IF NOT EXISTS cloud_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  environment text NOT NULL CHECK (environment IN ('production', 'staging')),
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS organizations (
  id text PRIMARY KEY,
  name text NOT NULL,
  credit_balance bigint NOT NULL DEFAULT 0 CHECK (credit_balance >= 0),
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  key text PRIMARY KEY,
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  organization_id text NOT NULL UNIQUE REFERENCES organizations (id),
  status text NOT NULL CHECK (status IN ('active', 'deleting', 'erased')),
  email text UNIQUE,
  phone text UNIQUE,
  name text,
  sessions_revoked_before bigint NOT NULL DEFAULT 0,
  devices_revoked_before bigint NOT NULL DEFAULT 0,
  device_epoch bigint NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  key text PRIMARY KEY,
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  user_id text NOT NULL REFERENCES accounts (key),
  access_digest text NOT NULL UNIQUE,
  refresh_digest text NOT NULL UNIQUE,
  live boolean NOT NULL,
  access_expires_at bigint NOT NULL,
  refresh_expires_at bigint NOT NULL,
  auth_at bigint NOT NULL,
  step_up_at bigint NOT NULL DEFAULT 0,
  mfa_at bigint NOT NULL DEFAULT 0,
  updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_refresh_sweep ON sessions (refresh_expires_at) WHERE live;

CREATE TABLE IF NOT EXISTS device_grants (
  key text PRIMARY KEY,
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  user_id text NOT NULL REFERENCES accounts (key),
  client_id text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('code_issued', 'exchanged', 'active', 'expired', 'ended')),
  code_digest text UNIQUE,
  credential_id text UNIQUE,
  secret_digest text UNIQUE,
  device_name text,
  code_challenge text,
  sealed_copy text,
  state_digest text,
  device_epoch bigint NOT NULL DEFAULT 0,
  renewed_from text,
  sign_in_at bigint,
  code_expires_at bigint NOT NULL,
  key_expires_at bigint NOT NULL DEFAULT 0,
  issued_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS device_grants_user ON device_grants (user_id);
CREATE INDEX IF NOT EXISTS device_grants_cleanup ON device_grants (phase, code_expires_at);
CREATE INDEX IF NOT EXISTS device_grants_live ON device_grants (user_id, key_expires_at) WHERE phase = 'active';
CREATE INDEX IF NOT EXISTS device_grants_renewed_from ON device_grants (renewed_from) WHERE renewed_from IS NOT NULL;

CREATE TABLE IF NOT EXISTS code_challenges (
  key text PRIMARY KEY,
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  method text NOT NULL CHECK (method IN ('email', 'sms')),
  purpose_key text NOT NULL,
  user_id text,
  client_id text NOT NULL,
  destination_digest text NOT NULL,
  code_digest text NOT NULL,
  code_challenge text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('unsent', 'open', 'locked', 'consumed', 'superseded', 'expired')),
  sent_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  CHECK ((purpose_key = 'sign-in') = (user_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS code_challenges_one_open ON code_challenges (method, purpose_key, destination_digest) WHERE phase = 'open';
CREATE INDEX IF NOT EXISTS code_challenges_destination ON code_challenges (method, purpose_key, destination_digest, sent_at DESC);
CREATE INDEX IF NOT EXISTS code_challenges_expiry ON code_challenges (expires_at);

CREATE TABLE IF NOT EXISTS cloud_sign_in_identities (
  provider text NOT NULL CHECK (provider IN ('google', 'email', 'sms')),
  provider_subject text NOT NULL,
  account_id text NOT NULL REFERENCES accounts (key),
  PRIMARY KEY (provider, provider_subject),
  UNIQUE (account_id, provider)
);

CREATE TABLE IF NOT EXISTS cloud_auth_limits (
  scope text NOT NULL,
  subject_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  hits integer NOT NULL CHECK (hits > 0),
  PRIMARY KEY (scope, subject_hash)
);

CREATE TABLE IF NOT EXISTS cloud_spent_refresh (
  digest text PRIMARY KEY,
  access_digest text NOT NULL UNIQUE,
  session_key text NOT NULL REFERENCES sessions (key),
  generation integer NOT NULL CHECK (generation > 0)
);
CREATE INDEX IF NOT EXISTS cloud_spent_refresh_session_idx ON cloud_spent_refresh (session_key);

CREATE TABLE IF NOT EXISTS cloud_device_proofs (
  grant_key text PRIMARY KEY REFERENCES device_grants (key) ON DELETE CASCADE,
  session_key text NOT NULL REFERENCES sessions (key),
  challenge text NOT NULL
);

CREATE TABLE IF NOT EXISTS cloud_code_challenges (
  provider text NOT NULL CHECK (provider IN ('email', 'sms')),
  destination text NOT NULL,
  challenge text NOT NULL,
  code_hash text,
  expires_at timestamptz NOT NULL,
  tries integer NOT NULL CHECK (tries BETWEEN 0 AND 5),
  consumed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (provider, destination),
  CHECK (provider <> 'email' OR code_hash IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS funds (
  key text PRIMARY KEY REFERENCES organizations (id),
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS referral_codes (
  code text PRIMARY KEY CHECK (code = upper(btrim(code)) AND code <> ''),
  user_id text NOT NULL UNIQUE REFERENCES accounts (key)
);

CREATE TABLE IF NOT EXISTS referral_uses (
  user_id text PRIMARY KEY REFERENCES accounts (key),
  code text NOT NULL,
  referrer_user_id text NOT NULL REFERENCES accounts (key),
  created_at bigint NOT NULL,
  CHECK (referrer_user_id <> user_id)
);
CREATE INDEX IF NOT EXISTS referral_uses_referrer ON referral_uses (referrer_user_id);

CREATE TABLE IF NOT EXISTS rate_windows (
  key text PRIMARY KEY,
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  window_end bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_windows_end ON rate_windows (window_end);

CREATE TABLE IF NOT EXISTS second_factors (
  key text PRIMARY KEY REFERENCES accounts (key),
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  totp_seed text,
  sms_phone text,
  pending_phone text,
  setup_digest text,
  challenge_id text UNIQUE,
  challenge_client_id text,
  challenge_digest text,
  step_up_session text,
  step_up_digest text
);

CREATE TABLE IF NOT EXISTS method_reviews (
  key text PRIMARY KEY REFERENCES accounts (key),
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS feed_accounts (
  account_id text PRIMARY KEY,
  handle text NOT NULL UNIQUE,
  display_name text NOT NULL,
  bio text NOT NULL DEFAULT '',
  avatar_url text,
  banner_url text,
  phone_hash text UNIQUE,
  phone_last2 text,
  phone_verified_at bigint,
  email_hash text,
  email_masked text,
  email_verified_at bigint,
  age_confirmed_at bigint,
  ui_mode text NOT NULL DEFAULT 'game' CHECK (ui_mode IN ('game', 'social')),
  balance_cents bigint NOT NULL DEFAULT 10000 CHECK (balance_cents >= 0),
  starting_grant_cents bigint NOT NULL DEFAULT 10000 CHECK (starting_grant_cents >= 0),
  total_fees_paid_cents bigint NOT NULL DEFAULT 0 CHECK (total_fees_paid_cents >= 0),
  is_admin boolean NOT NULL DEFAULT false,
  is_reviewer boolean NOT NULL DEFAULT false,
  reviewer_password_hash text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
ALTER TABLE feed_accounts DROP COLUMN IF EXISTS purchased_cents;
ALTER TABLE feed_accounts ADD COLUMN IF NOT EXISTS banner_url text;
ALTER TABLE feed_accounts ADD COLUMN IF NOT EXISTS email_hash text;
ALTER TABLE feed_accounts ADD COLUMN IF NOT EXISTS email_masked text;
ALTER TABLE feed_accounts ADD COLUMN IF NOT EXISTS email_verified_at bigint;
CREATE UNIQUE INDEX IF NOT EXISTS feed_accounts_email_hash_idx ON feed_accounts (email_hash) WHERE email_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS feed_phone_cooldowns (
  phone_hash text PRIMARY KEY,
  released_at bigint NOT NULL,
  expires_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS feed_email_magic_links (
  id text PRIMARY KEY,
  email_hash text NOT NULL,
  email_masked text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  purpose text NOT NULL CHECK (purpose IN ('sign_in', 'link_email')),
  account_id text REFERENCES feed_accounts (account_id),
  redirect_to text,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  consumed_at bigint,
  superseded_at bigint,
  CHECK ((purpose = 'sign_in' AND account_id IS NULL) OR (purpose = 'link_email' AND account_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS feed_email_magic_links_email_idx ON feed_email_magic_links (email_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS feed_email_magic_links_expiry_idx ON feed_email_magic_links (expires_at) WHERE consumed_at IS NULL AND superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS feed_email_cooldowns (
  email_hash text PRIMARY KEY,
  released_at bigint NOT NULL,
  expires_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS feed_agent_grants (
  grant_id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES feed_accounts (account_id),
  client_id text NOT NULL,
  client_name text NOT NULL,
  scopes text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at bigint NOT NULL,
  last_used_at bigint NOT NULL,
  revoked_at bigint
);
CREATE UNIQUE INDEX IF NOT EXISTS feed_agent_grants_one_active ON feed_agent_grants (account_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS feed_agent_grants_account_idx ON feed_agent_grants (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS feed_oauth_clients (
  client_id text PRIMARY KEY,
  client_name text NOT NULL,
  redirect_uris text NOT NULL DEFAULT '[]',
  client_uri text,
  is_cimd boolean NOT NULL DEFAULT false,
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS feed_oauth_codes (
  code_hash text PRIMARY KEY,
  client_id text NOT NULL,
  account_id text NOT NULL REFERENCES feed_accounts (account_id),
  redirect_uri text NOT NULL,
  scope text NOT NULL,
  resource text NOT NULL,
  code_challenge text NOT NULL,
  expires_at bigint NOT NULL,
  consumed_at bigint
);
CREATE INDEX IF NOT EXISTS feed_oauth_codes_account_idx ON feed_oauth_codes (account_id);
CREATE INDEX IF NOT EXISTS feed_oauth_codes_expiry_idx ON feed_oauth_codes (expires_at);

CREATE TABLE IF NOT EXISTS feed_oauth_tokens (
  token_hash text PRIMARY KEY,
  grant_id text NOT NULL REFERENCES feed_agent_grants (grant_id),
  account_id text NOT NULL REFERENCES feed_accounts (account_id),
  token_kind text NOT NULL CHECK (token_kind IN ('access', 'refresh')),
  family_id text NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  scope text NOT NULL,
  resource text NOT NULL,
  expires_at bigint NOT NULL,
  spent_at bigint,
  revoked_at bigint
);
CREATE INDEX IF NOT EXISTS feed_oauth_tokens_grant_idx ON feed_oauth_tokens (grant_id);
CREATE INDEX IF NOT EXISTS feed_oauth_tokens_family_idx ON feed_oauth_tokens (family_id);
CREATE INDEX IF NOT EXISTS feed_oauth_tokens_account_idx ON feed_oauth_tokens (account_id);

CREATE TABLE IF NOT EXISTS feed_device_codes (
  device_code_hash text PRIMARY KEY,
  user_code text NOT NULL,
  client_id text NOT NULL,
  client_name text NOT NULL,
  scope text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
  account_id text REFERENCES feed_accounts (account_id),
  expires_at bigint NOT NULL,
  interval_sec integer NOT NULL DEFAULT 5 CHECK (interval_sec > 0)
);
ALTER TABLE feed_device_codes DROP CONSTRAINT IF EXISTS feed_device_codes_user_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS feed_device_codes_pending_user_code_idx ON feed_device_codes (user_code) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS feed_device_codes_expiry_idx ON feed_device_codes (expires_at);

CREATE TABLE IF NOT EXISTS feed_actors (
  id text PRIMARY KEY,
  name text NOT NULL,
  username text NOT NULL UNIQUE,
  tier text NOT NULL,
  description text NOT NULL,
  system_prompt text NOT NULL,
  personality_json text NOT NULL DEFAULT '{}',
  profile_image_url text,
  profile_banner_url text,
  balance_cents bigint NOT NULL DEFAULT 10000000 CHECK (balance_cents >= 0),
  created_at bigint NOT NULL
);
ALTER TABLE feed_actors ADD COLUMN IF NOT EXISTS profile_image_url text;
ALTER TABLE feed_actors ADD COLUMN IF NOT EXISTS profile_banner_url text;

CREATE TABLE IF NOT EXISTS feed_organizations (
  id text PRIMARY KEY,
  name text NOT NULL,
  username text,
  ticker text UNIQUE,
  org_type text NOT NULL,
  description text NOT NULL,
  post_style text NOT NULL,
  can_be_involved boolean NOT NULL DEFAULT true,
  initial_price_cents bigint,
  image_url text,
  banner_url text,
  created_at bigint NOT NULL
);
ALTER TABLE feed_organizations ADD COLUMN IF NOT EXISTS username text;
ALTER TABLE feed_organizations ADD COLUMN IF NOT EXISTS image_url text;
ALTER TABLE feed_organizations ADD COLUMN IF NOT EXISTS banner_url text;
CREATE INDEX IF NOT EXISTS feed_organizations_username_idx ON feed_organizations (lower(username));

CREATE TABLE IF NOT EXISTS feed_world_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  current_day integer NOT NULL DEFAULT 1,
  current_hour integer NOT NULL DEFAULT 0,
  phase text NOT NULL DEFAULT 'active',
  game_running boolean NOT NULL DEFAULT true,
  funding_cutover_period bigint NOT NULL DEFAULT 0,
  last_tick_at bigint NOT NULL DEFAULT 0,
  updated_at bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS feed_world_facts (
  id text PRIMARY KEY,
  fact_text text NOT NULL,
  category text NOT NULL,
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS feed_world_events (
  id text PRIMARY KEY,
  event_type text NOT NULL,
  market_id text,
  headline text NOT NULL,
  summary text NOT NULL,
  actors_json text NOT NULL DEFAULT '[]',
  created_at bigint NOT NULL DEFAULT (floor(extract(epoch from now()) * 1000))::bigint
);
CREATE INDEX IF NOT EXISTS feed_world_events_created_idx ON feed_world_events (created_at DESC);
CREATE INDEX IF NOT EXISTS feed_world_events_market_idx ON feed_world_events (market_id, created_at DESC) WHERE market_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS feed_rss_headlines (
  id text PRIMARY KEY,
  source_url text NOT NULL,
  title text NOT NULL,
  parody_headline text,
  published_at bigint NOT NULL,
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS feed_posts (
  id text PRIMARY KEY,
  author_id text NOT NULL,
  author_kind text NOT NULL CHECK (author_kind IN ('user', 'npc', 'org')),
  content text NOT NULL,
  reply_to_post_id text,
  quote_post_id text,
  via_client_name text,
  market_id text,
  ticker text,
  like_count integer NOT NULL DEFAULT 0 CHECK (like_count >= 0),
  repost_count integer NOT NULL DEFAULT 0 CHECK (repost_count >= 0),
  reply_count integer NOT NULL DEFAULT 0 CHECK (reply_count >= 0),
  deleted_at bigint,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS feed_posts_created_idx ON feed_posts (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS feed_posts_author_idx ON feed_posts (author_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS feed_posts_reply_idx ON feed_posts (reply_to_post_id, created_at ASC) WHERE reply_to_post_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS feed_posts_market_idx ON feed_posts (market_id, created_at DESC) WHERE market_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS feed_posts_ticker_idx ON feed_posts (ticker, created_at DESC) WHERE ticker IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS feed_post_likes (
  post_id text NOT NULL REFERENCES feed_posts (id) ON DELETE CASCADE,
  account_id text NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (post_id, account_id)
);

CREATE TABLE IF NOT EXISTS feed_post_reposts (
  post_id text NOT NULL REFERENCES feed_posts (id) ON DELETE CASCADE,
  account_id text NOT NULL,
  repost_post_id text,
  created_at bigint NOT NULL,
  PRIMARY KEY (post_id, account_id)
);

CREATE TABLE IF NOT EXISTS feed_follows (
  follower_id text NOT NULL,
  target_id text NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('user', 'npc', 'org')),
  created_at bigint NOT NULL,
  PRIMARY KEY (follower_id, target_id, target_kind)
);
CREATE INDEX IF NOT EXISTS feed_follows_target_idx ON feed_follows (target_id, target_kind);

CREATE TABLE IF NOT EXISTS feed_blocks (
  blocker_id text NOT NULL,
  blocked_id text NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS feed_mutes (
  muter_id text NOT NULL,
  muted_id text NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (muter_id, muted_id)
);

CREATE TABLE IF NOT EXISTS feed_reports (
  id text PRIMARY KEY,
  reporter_id text NOT NULL,
  target_id text NOT NULL,
  target_kind text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'dismissed')),
  created_at bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS feed_reports_open_unique_idx ON feed_reports (reporter_id, target_kind, target_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS feed_notifications (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  kind text NOT NULL,
  actor_id text,
  post_id text,
  market_id text,
  chat_id text,
  invite_id text,
  title text NOT NULL,
  body text NOT NULL,
  is_game_only boolean NOT NULL DEFAULT false,
  read_at bigint,
  created_at bigint NOT NULL
);
ALTER TABLE feed_notifications ADD COLUMN IF NOT EXISTS chat_id text;
ALTER TABLE feed_notifications ADD COLUMN IF NOT EXISTS invite_id text;
CREATE INDEX IF NOT EXISTS feed_notifications_account_idx ON feed_notifications (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS feed_chats (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('direct', 'group', 'npc_alpha')),
  name text,
  created_by text NOT NULL,
  tier text,
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS feed_chat_members (
  chat_id text NOT NULL REFERENCES feed_chats (id) ON DELETE CASCADE,
  member_id text NOT NULL,
  member_kind text NOT NULL CHECK (member_kind IN ('user', 'npc')),
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  joined_at bigint NOT NULL,
  last_read_at bigint NOT NULL DEFAULT (floor(extract(epoch from now()) * 1000))::bigint,
  PRIMARY KEY (chat_id, member_id)
);
ALTER TABLE feed_chat_members ADD COLUMN IF NOT EXISTS last_read_at bigint NOT NULL DEFAULT (floor(extract(epoch from now()) * 1000))::bigint;
CREATE INDEX IF NOT EXISTS feed_chat_members_member_idx ON feed_chat_members (member_id);

CREATE TABLE IF NOT EXISTS feed_messages (
  id text PRIMARY KEY,
  chat_id text NOT NULL REFERENCES feed_chats (id) ON DELETE CASCADE,
  sender_id text NOT NULL,
  sender_kind text NOT NULL CHECK (sender_kind IN ('user', 'npc')),
  via_client_name text,
  body text NOT NULL,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS feed_messages_chat_idx ON feed_messages (chat_id, created_at ASC);

CREATE TABLE IF NOT EXISTS feed_message_reactions (
  message_id text NOT NULL REFERENCES feed_messages (id) ON DELETE CASCADE,
  account_id text NOT NULL,
  emoji text NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (message_id, account_id, emoji)
);

CREATE TABLE IF NOT EXISTS feed_group_invites (
  id text PRIMARY KEY,
  chat_id text NOT NULL REFERENCES feed_chats (id) ON DELETE CASCADE,
  invited_account_id text NOT NULL,
  invited_by_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at bigint NOT NULL,
  responded_at bigint
);
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'feed_group_invites' AND column_name = 'invited_by_npc_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'feed_group_invites' AND column_name = 'invited_by_id'
  ) THEN
    ALTER TABLE feed_group_invites RENAME COLUMN invited_by_npc_id TO invited_by_id;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS feed_group_invites_account_idx ON feed_group_invites (invited_account_id, status);

CREATE TABLE IF NOT EXISTS feed_alpha_invite_cooldowns (
  actor_id text NOT NULL REFERENCES feed_actors (id) ON DELETE CASCADE,
  account_id text NOT NULL,
  decline_count integer NOT NULL DEFAULT 0 CHECK (decline_count >= 0),
  next_eligible_at bigint NOT NULL,
  updated_at bigint NOT NULL DEFAULT (floor(extract(epoch from now()) * 1000))::bigint,
  PRIMARY KEY (actor_id, account_id)
);
CREATE INDEX IF NOT EXISTS feed_alpha_invite_cooldowns_account_idx ON feed_alpha_invite_cooldowns (account_id, next_eligible_at);

CREATE TABLE IF NOT EXISTS feed_prediction_markets (
  id text PRIMARY KEY,
  slot_index integer,
  question text NOT NULL,
  description text NOT NULL,
  category text NOT NULL,
  timeframe text NOT NULL,
  phase text NOT NULL,
  yes_shares bigint NOT NULL CHECK (yes_shares > 0),
  no_shares bigint NOT NULL CHECK (no_shares > 0),
  liquidity_cents bigint NOT NULL CHECK (liquidity_cents >= 0),
  secret_outcome text CHECK (secret_outcome IN ('YES', 'NO')),
  status text NOT NULL CHECK (status IN ('open', 'expired', 'awaiting_proof', 'manual_hold', 'resolved', 'cancelled')),
  resolved_outcome text CHECK (resolved_outcome IS NULL OR resolved_outcome IN ('YES', 'NO')),
  resolution_proof text,
  resolution_article_id text,
  expires_at bigint NOT NULL,
  resolved_at bigint,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS feed_prediction_markets_status_idx ON feed_prediction_markets (status, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_feed_prediction_markets_open_slot ON feed_prediction_markets (slot_index) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS feed_prediction_positions (
  market_id text NOT NULL REFERENCES feed_prediction_markets (id) ON DELETE CASCADE,
  holder_id text NOT NULL,
  holder_kind text NOT NULL CHECK (holder_kind IN ('user', 'npc')),
  side text NOT NULL CHECK (side IN ('YES', 'NO')),
  shares bigint NOT NULL DEFAULT 0 CHECK (shares >= 0),
  cost_basis_cents bigint NOT NULL DEFAULT 0 CHECK (cost_basis_cents >= 0),
  settled_at bigint,
  payout_cents bigint NOT NULL DEFAULT 0 CHECK (payout_cents >= 0),
  PRIMARY KEY (market_id, holder_id, side)
);
CREATE INDEX IF NOT EXISTS feed_prediction_positions_holder_idx ON feed_prediction_positions (holder_id);

CREATE TABLE IF NOT EXISTS feed_prediction_resolution_work (
  market_id text PRIMARY KEY REFERENCES feed_prediction_markets (id) ON DELETE CASCADE,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  next_retry_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS feed_prediction_resolution_work_retry_idx ON feed_prediction_resolution_work (next_retry_at);

CREATE TABLE IF NOT EXISTS feed_spot_pools (
  ticker text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES feed_organizations (id),
  base_reserve bigint NOT NULL CHECK (base_reserve > 0),
  quote_reserve_cents bigint NOT NULL CHECK (quote_reserve_cents > 0),
  index_price_cents bigint NOT NULL CHECK (index_price_cents > 0),
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS feed_perp_markets (
  ticker text PRIMARY KEY,
  index_price_cents bigint NOT NULL CHECK (index_price_cents > 0),
  mark_price_cents bigint NOT NULL CHECK (mark_price_cents > 0),
  long_oi_cents bigint NOT NULL DEFAULT 0 CHECK (long_oi_cents >= 0),
  short_oi_cents bigint NOT NULL DEFAULT 0 CHECK (short_oi_cents >= 0),
  max_leverage integer NOT NULL DEFAULT 20 CHECK (max_leverage BETWEEN 1 AND 20),
  funding_rate_bps integer NOT NULL DEFAULT 0,
  last_funding_period bigint NOT NULL DEFAULT 0,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS feed_npc_spot_holdings (
  actor_id text NOT NULL REFERENCES feed_actors (id) ON DELETE CASCADE,
  ticker text NOT NULL REFERENCES feed_perp_markets (ticker) ON DELETE CASCADE,
  base_units bigint NOT NULL DEFAULT 0 CHECK (base_units >= 0),
  updated_at bigint NOT NULL DEFAULT (floor(extract(epoch from now()) * 1000))::bigint,
  PRIMARY KEY (actor_id, ticker)
);
CREATE INDEX IF NOT EXISTS feed_npc_spot_holdings_ticker_idx ON feed_npc_spot_holdings (ticker);

CREATE TABLE IF NOT EXISTS feed_perp_positions (
  id text PRIMARY KEY,
  ticker text NOT NULL REFERENCES feed_perp_markets (ticker),
  holder_id text NOT NULL,
  holder_kind text NOT NULL CHECK (holder_kind IN ('user', 'npc')),
  side text NOT NULL CHECK (side IN ('LONG', 'SHORT')),
  margin_cents bigint NOT NULL CHECK (margin_cents > 0),
  size_cents bigint NOT NULL CHECK (size_cents > 0),
  entry_price_cents bigint NOT NULL CHECK (entry_price_cents > 0),
  leverage integer NOT NULL CHECK (leverage BETWEEN 1 AND 20),
  accrued_funding_cents bigint NOT NULL DEFAULT 0,
  last_funding_period bigint NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('open', 'closed', 'liquidated')),
  realized_pnl_cents bigint NOT NULL DEFAULT 0,
  closed_at bigint,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS feed_perp_positions_holder_idx ON feed_perp_positions (holder_id, status);
CREATE INDEX IF NOT EXISTS feed_perp_positions_ticker_open_idx ON feed_perp_positions (ticker) WHERE status = 'open';
CREATE UNIQUE INDEX IF NOT EXISTS idx_feed_perp_positions_open_holder_ticker ON feed_perp_positions (holder_id, ticker) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS feed_perp_funding_periods (
  position_id text NOT NULL REFERENCES feed_perp_positions (id) ON DELETE CASCADE,
  period_index bigint NOT NULL,
  funding_delta_cents bigint NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (position_id, period_index)
);

CREATE TABLE IF NOT EXISTS feed_market_price_history (
  id text PRIMARY KEY,
  market_kind text NOT NULL CHECK (market_kind IN ('prediction', 'perp', 'spot')),
  market_ref text NOT NULL,
  price_cents bigint NOT NULL CHECK (price_cents >= 0),
  yes_price_bps integer CHECK (yes_price_bps IS NULL OR (yes_price_bps >= 0 AND yes_price_bps <= 10000)),
  mark_price_cents bigint CHECK (mark_price_cents IS NULL OR mark_price_cents >= 0),
  volume_cents bigint NOT NULL DEFAULT 0 CHECK (volume_cents >= 0),
  recorded_at bigint NOT NULL DEFAULT (floor(extract(epoch from now()) * 1000))::bigint
);
CREATE INDEX IF NOT EXISTS feed_market_price_history_lookup_idx ON feed_market_price_history (market_kind, market_ref, recorded_at DESC);

CREATE TABLE IF NOT EXISTS feed_trades (
  id text PRIMARY KEY,
  trader_id text NOT NULL,
  trader_kind text NOT NULL CHECK (trader_kind IN ('user', 'npc')),
  market_kind text NOT NULL CHECK (market_kind IN ('prediction', 'spot', 'perp')),
  market_ref text NOT NULL,
  side text NOT NULL,
  notional_cents bigint NOT NULL CHECK (notional_cents >= 0),
  fee_cents bigint NOT NULL CHECK (fee_cents >= 0),
  shares_or_size bigint NOT NULL,
  price_cents bigint NOT NULL CHECK (price_cents >= 0),
  realized_pnl_cents bigint,
  via_client_name text,
  idempotency_key text,
  request_fingerprint text,
  receipt_json text,
  created_at bigint NOT NULL
);
ALTER TABLE feed_trades ADD COLUMN IF NOT EXISTS realized_pnl_cents bigint;
ALTER TABLE feed_trades ADD COLUMN IF NOT EXISTS request_fingerprint text;
ALTER TABLE feed_trades ADD COLUMN IF NOT EXISTS receipt_json text;
ALTER TABLE feed_trades DROP CONSTRAINT IF EXISTS feed_trades_idempotency_key_key;
CREATE INDEX IF NOT EXISTS feed_trades_trader_idx ON feed_trades (trader_id, created_at DESC);
CREATE INDEX IF NOT EXISTS feed_trades_market_idx ON feed_trades (market_kind, market_ref, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS feed_trades_trader_idempotency_idx ON feed_trades (trader_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS feed_point_ledger (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  kind text NOT NULL,
  delta_cents bigint NOT NULL,
  balance_after_cents bigint NOT NULL CHECK (balance_after_cents >= 0),
  ref_id text,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS feed_point_ledger_account_idx ON feed_point_ledger (account_id, created_at DESC);

DROP TABLE IF EXISTS feed_stripe_reversals;
DROP TABLE IF EXISTS feed_stripe_purchases;

CREATE TABLE IF NOT EXISTS feed_npc_market_clues (
  clue_key text PRIMARY KEY,
  market_id text NOT NULL REFERENCES feed_prediction_markets (id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES feed_actors (id),
  phase text NOT NULL,
  post_id text,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS feed_npc_market_clues_market_idx ON feed_npc_market_clues (market_id, created_at DESC);

CREATE TABLE IF NOT EXISTS feed_llm_spend_reservations (
  attempt_id text PRIMARY KEY,
  utc_day text NOT NULL,
  reserved_micros bigint NOT NULL CHECK (reserved_micros >= 0),
  actual_micros bigint CHECK (actual_micros IS NULL OR actual_micros >= 0),
  status text NOT NULL CHECK (status IN ('reserved', 'settled', 'uncertain', 'released')),
  provider text NOT NULL,
  model text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS feed_llm_spend_day_idx ON feed_llm_spend_reservations (utc_day, status);

CREATE TABLE IF NOT EXISTS feed_tick_health (
  job_name text PRIMARY KEY,
  last_run_at bigint,
  last_success_at bigint,
  last_status text,
  last_error text,
  pending_count integer NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
  oldest_pending_at bigint,
  duration_ms integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0)
);

CREATE TABLE IF NOT EXISTS feed_articles (
  id text PRIMARY KEY,
  title text NOT NULL,
  summary text NOT NULL,
  body text NOT NULL,
  author_org_id text NOT NULL,
  related_market_id text,
  image_url text,
  is_resolution_proof boolean NOT NULL DEFAULT false,
  published_at bigint NOT NULL
);
ALTER TABLE feed_articles ADD COLUMN IF NOT EXISTS image_url text;
CREATE INDEX IF NOT EXISTS feed_articles_published_idx ON feed_articles (published_at DESC);

CREATE TABLE IF NOT EXISTS feed_rate_limits (
  scope_key text PRIMARY KEY,
  window_start bigint NOT NULL,
  count integer NOT NULL CHECK (count >= 0)
);

CREATE TABLE IF NOT EXISTS feed_job_leases (
  job_name text PRIMARY KEY,
  owner_id text NOT NULL,
  lease_until bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS feed_realtime_events (
  seq bigserial PRIMARY KEY,
  origin_isolate text NOT NULL,
  payload_json text NOT NULL,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS feed_realtime_events_created_idx ON feed_realtime_events (created_at);
