-- ============================================================
-- TON Poker Platform — PostgreSQL Schema
-- Append-only ledger design. Never UPDATE financial rows.
-- ============================================================

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- ENUMS
-- ============================================================

CREATE TYPE user_role AS ENUM ('platform_owner', 'club_owner', 'agent', 'player');
CREATE TYPE club_status AS ENUM ('active', 'suspended', 'closed');
CREATE TYPE table_status AS ENUM ('waiting', 'active', 'paused', 'closed');
CREATE TYPE hand_status AS ENUM ('dealing', 'preflop', 'flop', 'turn', 'river', 'showdown', 'complete');
CREATE TYPE action_type AS ENUM ('fold', 'check', 'call', 'raise', 'all_in', 'small_blind', 'big_blind');
CREATE TYPE tx_type AS ENUM ('deposit', 'withdrawal', 'rake_club', 'rake_platform', 'transfer_in', 'transfer_out', 'bonus', 'adjustment');
CREATE TYPE tx_status AS ENUM ('pending', 'confirmed', 'failed', 'cancelled');
CREATE TYPE withdrawal_status AS ENUM ('pending', 'approved', 'processing', 'completed', 'rejected');
CREATE TYPE tournament_status AS ENUM ('registering', 'running', 'paused', 'complete', 'cancelled');

-- ============================================================
-- USERS
-- ============================================================

CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  telegram_id     BIGINT UNIQUE NOT NULL,
  telegram_username TEXT,
  telegram_first_name TEXT,
  telegram_last_name TEXT,
  telegram_photo_url TEXT,
  ton_address     TEXT UNIQUE,
  role            user_role NOT NULL DEFAULT 'player',
  is_banned       BOOLEAN NOT NULL DEFAULT FALSE,
  ban_reason      TEXT,
  banned_at       TIMESTAMPTZ,
  banned_by       UUID REFERENCES users(id),
  referral_code   TEXT UNIQUE DEFAULT encode(gen_random_bytes(6), 'hex'),
  referred_by     UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_telegram_id ON users(telegram_id);
CREATE INDEX idx_users_ton_address ON users(ton_address);
CREATE INDEX idx_users_referral_code ON users(referral_code);

-- ============================================================
-- PLATFORM CONFIG (singleton row)
-- ============================================================

CREATE TABLE platform_config (
  id                    INT PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- singleton
  platform_rake_pct     NUMERIC(5,4) NOT NULL DEFAULT 0.4000,    -- 40% of club rake
  platform_wallet       TEXT NOT NULL,                            -- TON treasury address
  min_deposit_ton       NUMERIC(20,9) NOT NULL DEFAULT 1.0,
  max_withdrawal_ton    NUMERIC(20,9) NOT NULL DEFAULT 10000.0,
  withdrawal_requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  maintenance_mode      BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by            UUID REFERENCES users(id)
);

-- ============================================================
-- CLUBS
-- ============================================================

CREATE TABLE clubs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id        UUID NOT NULL REFERENCES users(id),
  name            TEXT NOT NULL,
  description     TEXT,
  invite_code     TEXT UNIQUE DEFAULT encode(gen_random_bytes(5), 'hex'),
  logo_url        TEXT,
  status          club_status NOT NULL DEFAULT 'active',
  rake_pct        NUMERIC(5,4) NOT NULL DEFAULT 0.05,     -- 5% of pot
  club_rake_share NUMERIC(5,4) NOT NULL DEFAULT 0.60,     -- club owner gets 60% of rake
  -- platform gets (1 - club_rake_share) * rake_pct
  max_players     INT NOT NULL DEFAULT 500,
  is_public       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_clubs_owner_id ON clubs(owner_id);
CREATE INDEX idx_clubs_invite_code ON clubs(invite_code);

-- ============================================================
-- CLUB MEMBERS
-- ============================================================

CREATE TABLE club_members (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  club_id         UUID NOT NULL REFERENCES clubs(id),
  user_id         UUID NOT NULL REFERENCES users(id),
  role            TEXT NOT NULL DEFAULT 'player', -- 'player', 'agent', 'manager'
  agent_id        UUID REFERENCES users(id),       -- which agent recruited this player
  rakeback_pct    NUMERIC(5,4) NOT NULL DEFAULT 0, -- player's rakeback from club
  nickname        TEXT,
  is_banned       BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(club_id, user_id)
);

CREATE INDEX idx_club_members_club_id ON club_members(club_id);
CREATE INDEX idx_club_members_user_id ON club_members(user_id);
CREATE INDEX idx_club_members_agent_id ON club_members(agent_id);

-- ============================================================
-- BALANCES (materialized — rebuilt from ledger)
-- These are CACHES. Source of truth is the ledger.
-- ============================================================

CREATE TABLE user_balances (
  user_id         UUID PRIMARY KEY REFERENCES users(id),
  club_id         UUID REFERENCES clubs(id),        -- NULL = platform balance
  balance_ton     NUMERIC(20,9) NOT NULL DEFAULT 0,
  locked_ton      NUMERIC(20,9) NOT NULL DEFAULT 0, -- chips at table (locked)
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, club_id)
);

-- One balance per user per club
CREATE UNIQUE INDEX idx_user_balances_user_club ON user_balances(user_id, COALESCE(club_id, '00000000-0000-0000-0000-000000000000'::UUID));

-- ============================================================
-- LEDGER (append-only financial record)
-- ============================================================

CREATE TABLE ledger (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id),
  club_id         UUID REFERENCES clubs(id),
  tx_type         tx_type NOT NULL,
  amount_ton      NUMERIC(20,9) NOT NULL,            -- positive = credit, negative = debit
  balance_after   NUMERIC(20,9) NOT NULL,
  reference_id    UUID,                              -- hand_id, tournament_id, etc.
  reference_type  TEXT,                              -- 'hand', 'deposit', 'withdrawal'
  idempotency_key TEXT UNIQUE,                       -- prevent duplicate credits
  meta            JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ledger_user_id ON ledger(user_id);
CREATE INDEX idx_ledger_club_id ON ledger(club_id);
CREATE INDEX idx_ledger_reference ON ledger(reference_id, reference_type);
CREATE INDEX idx_ledger_created_at ON ledger(created_at);
CREATE INDEX idx_ledger_idempotency ON ledger(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ============================================================
-- TON TRANSACTIONS
-- ============================================================

CREATE TABLE ton_transactions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id),
  tx_type         tx_type NOT NULL,
  status          tx_status NOT NULL DEFAULT 'pending',
  amount_ton      NUMERIC(20,9) NOT NULL,
  ton_hash        TEXT UNIQUE,                       -- blockchain tx hash
  from_address    TEXT,
  to_address      TEXT NOT NULL,
  confirmations   INT NOT NULL DEFAULT 0,
  required_confirmations INT NOT NULL DEFAULT 3,
  block_lt        BIGINT,                            -- TON logical time
  block_hash      TEXT,
  raw_message     JSONB,                             -- full TON tx payload
  processed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ton_tx_user_id ON ton_transactions(user_id);
CREATE INDEX idx_ton_tx_hash ON ton_transactions(ton_hash) WHERE ton_hash IS NOT NULL;
CREATE INDEX idx_ton_tx_status ON ton_transactions(status);

-- ============================================================
-- WITHDRAWAL REQUESTS
-- ============================================================

CREATE TABLE withdrawal_requests (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id),
  club_id         UUID REFERENCES clubs(id),
  amount_ton      NUMERIC(20,9) NOT NULL,
  to_address      TEXT NOT NULL,
  status          withdrawal_status NOT NULL DEFAULT 'pending',
  approved_by     UUID REFERENCES users(id),
  approved_at     TIMESTAMPTZ,
  reject_reason   TEXT,
  ton_tx_id       UUID REFERENCES ton_transactions(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_withdrawals_user_id ON withdrawal_requests(user_id);
CREATE INDEX idx_withdrawals_status ON withdrawal_requests(status);

-- ============================================================
-- POKER TABLES
-- ============================================================

CREATE TABLE poker_tables (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  club_id         UUID NOT NULL REFERENCES clubs(id),
  name            TEXT NOT NULL,
  status          table_status NOT NULL DEFAULT 'waiting',
  game_type       TEXT NOT NULL DEFAULT 'texas_holdem',
  max_seats       INT NOT NULL DEFAULT 9 CHECK (max_seats BETWEEN 2 AND 9),
  small_blind     NUMERIC(20,9) NOT NULL,
  big_blind       NUMERIC(20,9) NOT NULL,
  min_buy_in      NUMERIC(20,9) NOT NULL,
  max_buy_in      NUMERIC(20,9) NOT NULL,
  ante            NUMERIC(20,9) NOT NULL DEFAULT 0,
  rake_pct        NUMERIC(5,4),                      -- NULL = inherit from club
  rake_cap        NUMERIC(20,9),                     -- max rake per hand
  time_bank_secs  INT NOT NULL DEFAULT 30,
  action_timeout  INT NOT NULL DEFAULT 20,           -- seconds per action
  created_by      UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_poker_tables_club_id ON poker_tables(club_id);
CREATE INDEX idx_poker_tables_status ON poker_tables(status);

-- ============================================================
-- TABLE SEATS (current session seating)
-- ============================================================

CREATE TABLE table_seats (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  table_id        UUID NOT NULL REFERENCES poker_tables(id),
  user_id         UUID NOT NULL REFERENCES users(id),
  seat_number     INT NOT NULL CHECK (seat_number BETWEEN 1 AND 9),
  stack_ton       NUMERIC(20,9) NOT NULL,            -- chips at table
  is_sitting_out  BOOLEAN NOT NULL DEFAULT FALSE,
  connected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(table_id, seat_number),
  UNIQUE(table_id, user_id)
);

CREATE INDEX idx_table_seats_table_id ON table_seats(table_id);
CREATE INDEX idx_table_seats_user_id ON table_seats(user_id);

-- ============================================================
-- HANDS
-- ============================================================

CREATE TABLE hands (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  table_id        UUID NOT NULL REFERENCES poker_tables(id),
  hand_number     BIGINT NOT NULL,
  status          hand_status NOT NULL DEFAULT 'dealing',
  deck_seed       TEXT NOT NULL,                     -- CSPRNG seed (revealed post-hand)
  deck_hash       TEXT NOT NULL,                     -- SHA256 of seed (committed pre-deal)
  community_cards JSONB DEFAULT '[]',                -- [{rank, suit}, ...]
  pot_total       NUMERIC(20,9) NOT NULL DEFAULT 0,
  rake_total      NUMERIC(20,9) NOT NULL DEFAULT 0,
  rake_club       NUMERIC(20,9) NOT NULL DEFAULT 0,
  rake_platform   NUMERIC(20,9) NOT NULL DEFAULT 0,
  button_seat     INT NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at        TIMESTAMPTZ,
  UNIQUE(table_id, hand_number)
);

CREATE INDEX idx_hands_table_id ON hands(table_id);
CREATE INDEX idx_hands_started_at ON hands(started_at);

-- ============================================================
-- HAND PLAYERS (snapshot of who played in each hand)
-- ============================================================

CREATE TABLE hand_players (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  hand_id         UUID NOT NULL REFERENCES hands(id),
  user_id         UUID NOT NULL REFERENCES users(id),
  seat_number     INT NOT NULL,
  stack_start     NUMERIC(20,9) NOT NULL,
  stack_end       NUMERIC(20,9),
  hole_cards      JSONB,                             -- encrypted during hand, revealed after
  final_hand      TEXT,                              -- 'royal_flush', 'two_pair', etc.
  amount_won      NUMERIC(20,9) NOT NULL DEFAULT 0,
  amount_wagered  NUMERIC(20,9) NOT NULL DEFAULT 0,
  is_winner       BOOLEAN NOT NULL DEFAULT FALSE,
  folded_at_street TEXT,
  UNIQUE(hand_id, user_id)
);

CREATE INDEX idx_hand_players_hand_id ON hand_players(hand_id);
CREATE INDEX idx_hand_players_user_id ON hand_players(user_id);

-- ============================================================
-- HAND ACTIONS
-- ============================================================

CREATE TABLE hand_actions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  hand_id         UUID NOT NULL REFERENCES hands(id),
  user_id         UUID NOT NULL REFERENCES users(id),
  seat_number     INT NOT NULL,
  street          TEXT NOT NULL,                     -- 'preflop', 'flop', 'turn', 'river'
  action          action_type NOT NULL,
  amount          NUMERIC(20,9) NOT NULL DEFAULT 0,
  pot_before      NUMERIC(20,9) NOT NULL,
  sequence_num    INT NOT NULL,                      -- ordering within hand
  acted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  time_taken_ms   INT
);

CREATE INDEX idx_hand_actions_hand_id ON hand_actions(hand_id);
CREATE INDEX idx_hand_actions_user_id ON hand_actions(user_id);

-- ============================================================
-- AGENT / REFERRAL SYSTEM
-- ============================================================

CREATE TABLE agent_configs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  club_id         UUID NOT NULL REFERENCES clubs(id),
  agent_id        UUID NOT NULL REFERENCES users(id),
  commission_pct  NUMERIC(5,4) NOT NULL DEFAULT 0.10, -- 10% of player rake
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(club_id, agent_id)
);

CREATE TABLE agent_earnings (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id        UUID NOT NULL REFERENCES users(id),
  club_id         UUID NOT NULL REFERENCES clubs(id),
  player_id       UUID NOT NULL REFERENCES users(id),
  hand_id         UUID NOT NULL REFERENCES hands(id),
  player_rake     NUMERIC(20,9) NOT NULL,
  commission      NUMERIC(20,9) NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_earnings_agent_id ON agent_earnings(agent_id);
CREATE INDEX idx_agent_earnings_hand_id ON agent_earnings(hand_id);

-- ============================================================
-- TOURNAMENTS (future — schema ready)
-- ============================================================

CREATE TABLE tournaments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  club_id         UUID NOT NULL REFERENCES clubs(id),
  name            TEXT NOT NULL,
  status          tournament_status NOT NULL DEFAULT 'registering',
  buy_in_ton      NUMERIC(20,9) NOT NULL,
  re_buy_ton      NUMERIC(20,9),
  addon_ton       NUMERIC(20,9),
  max_players     INT,
  starting_chips  BIGINT NOT NULL DEFAULT 10000,
  blind_structure JSONB NOT NULL DEFAULT '[]',       -- [{level, sb, bb, ante, duration_mins}]
  prize_pool      NUMERIC(20,9) NOT NULL DEFAULT 0,
  payout_structure JSONB DEFAULT '[]',
  starts_at       TIMESTAMPTZ,
  ended_at        TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- AUDIT LOG (immutable platform-wide audit trail)
-- ============================================================

CREATE TABLE audit_log (
  id              BIGSERIAL PRIMARY KEY,
  actor_id        UUID REFERENCES users(id),
  action          TEXT NOT NULL,
  target_type     TEXT,
  target_id       UUID,
  old_value       JSONB,
  new_value       JSONB,
  ip_address      INET,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_log_actor_id ON audit_log(actor_id);
CREATE INDEX idx_audit_log_target ON audit_log(target_type, target_id);
CREATE INDEX idx_audit_log_created_at ON audit_log(created_at);

-- ============================================================
-- FRAUD SIGNALS
-- ============================================================

CREATE TABLE fraud_signals (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id),
  signal_type     TEXT NOT NULL,   -- 'collusion_suspect', 'vpn_detected', 'unusual_winrate', etc.
  severity        TEXT NOT NULL DEFAULT 'low',
  details         JSONB DEFAULT '{}',
  resolved        BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_by     UUID REFERENCES users(id),
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_fraud_signals_user_id ON fraud_signals(user_id);
CREATE INDEX idx_fraud_signals_resolved ON fraud_signals(resolved);

-- ============================================================
-- FUNCTIONS & TRIGGERS
-- ============================================================

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_clubs_updated_at BEFORE UPDATE ON clubs FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_poker_tables_updated_at BEFORE UPDATE ON poker_tables FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_ton_tx_updated_at BEFORE UPDATE ON ton_transactions FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_withdrawal_updated_at BEFORE UPDATE ON withdrawal_requests FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Prevent balance going negative
CREATE OR REPLACE FUNCTION check_balance_non_negative()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.balance_ton < 0 THEN
    RAISE EXCEPTION 'Balance cannot go negative: user_id=%, club_id=%', NEW.user_id, NEW.club_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_balance_non_negative
  BEFORE INSERT OR UPDATE ON user_balances
  FOR EACH ROW EXECUTE FUNCTION check_balance_non_negative();
