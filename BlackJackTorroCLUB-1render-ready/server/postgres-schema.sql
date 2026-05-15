-- PostgreSQL schema draft for production migration.
-- Current runtime uses SQLite via node:sqlite. This schema mirrors the same entities.

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  avatar TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  system BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);

CREATE TABLE IF NOT EXISTS balances (
  user_id BIGINT PRIMARY KEY,
  bjt BIGINT NOT NULL DEFAULT 0 CHECK (bjt >= 0),
  stars BIGINT NOT NULL DEFAULT 0 CHECK (stars >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_logs (
  id TEXT PRIMARY KEY,
  admin_id BIGINT NOT NULL,
  action TEXT NOT NULL,
  target_id BIGINT NOT NULL,
  amount BIGINT NOT NULL CHECK (amount >= 0),
  currency TEXT NOT NULL CHECK (currency IN ('bjt', 'stars')),
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_logs_created_at ON admin_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_admin_logs_admin_id ON admin_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_logs_target_id ON admin_logs(target_id);

CREATE TABLE IF NOT EXISTS currency_transactions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('grant', 'convert', 'payment', 'refund', 'system')),
  user_id BIGINT NOT NULL REFERENCES balances(user_id),
  admin_id BIGINT,
  delta_bjt BIGINT NOT NULL DEFAULT 0,
  delta_stars BIGINT NOT NULL DEFAULT 0,
  balance_bjt BIGINT NOT NULL CHECK (balance_bjt >= 0),
  balance_stars BIGINT NOT NULL CHECK (balance_stars >= 0),
  currency TEXT CHECK (currency IN ('bjt', 'stars')),
  amount BIGINT NOT NULL DEFAULT 0 CHECK (amount >= 0),
  reason TEXT NOT NULL DEFAULT '',
  request_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_currency_transactions_created_at ON currency_transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_currency_transactions_user_id ON currency_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_currency_transactions_admin_id ON currency_transactions(admin_id);

-- Suggested future tables:
-- CREATE TABLE user_roles (user_id BIGINT PRIMARY KEY, role TEXT NOT NULL CHECK (role IN ('admin','moderator')));
-- CREATE TABLE moderation_actions (...);
-- CREATE TABLE payment_events (...);
