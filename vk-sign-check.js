/**
 * SQLite-хранилище проекта.
 *
 * В этой версии JSON используется только как legacy-источник для первой миграции.
 * Основные данные живут в SQLite: сообщения, балансы, админ-журнал и отдельный
 * журнал транзакций валюты. Все операции с валютой выполняются транзакционно.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
const sqlitePath = process.env.SQLITE_PATH || path.join(dataDir, 'bar.sqlite');
const legacyJsonPath = path.join(dataDir, 'bar.json');
const MAX_STORED_MESSAGES = clampInt(process.env.MAX_STORED_MESSAGES, 100, 50000, 5000);
const MAX_ADMIN_LOGS = clampInt(process.env.MAX_ADMIN_LOGS, 100, 50000, 5000);
const MAX_TRANSACTIONS = clampInt(process.env.MAX_TRANSACTIONS, 100, 100000, 20000);
const DEFAULT_BJT = clampInt(process.env.DEFAULT_INITIAL_BJT, 0, 1000000, 50);
const ADMIN_INITIAL_BJT = clampInt(process.env.ADMIN_INITIAL_BJT, 0, 1000000000, 1000);

let db;
let statements;

export function initializeDatabase() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  db = new DatabaseSync(sqlitePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      userId INTEGER NOT NULL,
      name TEXT NOT NULL,
      avatar TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      system INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_userId ON messages(userId);

    CREATE TABLE IF NOT EXISTS balances (
      user_id INTEGER PRIMARY KEY,
      bjt INTEGER NOT NULL DEFAULT 0 CHECK (bjt >= 0),
      stars INTEGER NOT NULL DEFAULT 0 CHECK (stars >= 0),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_logs (
      id TEXT PRIMARY KEY,
      admin_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      amount INTEGER NOT NULL CHECK (amount >= 0),
      currency TEXT NOT NULL CHECK (currency IN ('bjt', 'stars')),
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_admin_logs_created_at ON admin_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_admin_logs_admin_id ON admin_logs(admin_id);
    CREATE INDEX IF NOT EXISTS idx_admin_logs_target_id ON admin_logs(target_id);

    CREATE TABLE IF NOT EXISTS currency_transactions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('grant', 'convert', 'payment', 'refund', 'system')),
      user_id INTEGER NOT NULL,
      admin_id INTEGER,
      delta_bjt INTEGER NOT NULL DEFAULT 0,
      delta_stars INTEGER NOT NULL DEFAULT 0,
      balance_bjt INTEGER NOT NULL CHECK (balance_bjt >= 0),
      balance_stars INTEGER NOT NULL CHECK (balance_stars >= 0),
      currency TEXT CHECK (currency IN ('bjt', 'stars')),
      amount INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
      reason TEXT NOT NULL DEFAULT '',
      request_id TEXT UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_currency_transactions_created_at ON currency_transactions(created_at);
    CREATE INDEX IF NOT EXISTS idx_currency_transactions_user_id ON currency_transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_currency_transactions_admin_id ON currency_transactions(admin_id);
  `);

  prepareStatements();
  migrateLegacyJsonOnce();

  console.log(`✅ Database initialized: SQLite (${sqlitePath})`);
}

function prepareStatements() {
  statements = {
    countMessages: db.prepare('SELECT COUNT(*) AS count FROM messages'),
    countBalances: db.prepare('SELECT COUNT(*) AS count FROM balances'),
    countAdminLogs: db.prepare('SELECT COUNT(*) AS count FROM admin_logs'),
    countTransactions: db.prepare('SELECT COUNT(*) AS count FROM currency_transactions'),
    insertMessage: db.prepare(`
      INSERT OR REPLACE INTO messages (id, userId, name, avatar, text, created_at, system)
      VALUES (:id, :userId, :name, :avatar, :text, :createdAt, :system)
    `),
    recentMessages: db.prepare(`
      SELECT id, userId, name, avatar, text, created_at AS createdAt, system
      FROM messages
      ORDER BY created_at DESC
      LIMIT ?
    `),
    pruneMessages: db.prepare(`
      DELETE FROM messages
      WHERE rowid NOT IN (
        SELECT rowid FROM messages ORDER BY created_at DESC LIMIT ?
      )
    `),
    deleteOldMessages: db.prepare('DELETE FROM messages WHERE created_at < ?'),
    getBalance: db.prepare('SELECT bjt, stars FROM balances WHERE user_id = ?'),
    upsertBalance: db.prepare(`
      INSERT INTO balances (user_id, bjt, stars, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        bjt = excluded.bjt,
        stars = excluded.stars,
        updated_at = excluded.updated_at
    `),
    insertAdminLog: db.prepare(`
      INSERT INTO admin_logs (id, admin_id, action, target_id, amount, currency, reason, created_at)
      VALUES (:id, :adminId, :action, :targetId, :amount, :currency, :reason, :createdAt)
    `),
    adminLogs: db.prepare(`
      SELECT id, admin_id AS adminId, action, target_id AS targetId, amount, currency, reason, created_at AS createdAt
      FROM admin_logs
      ORDER BY created_at DESC
      LIMIT ?
    `),
    adminLogsByAdmin: db.prepare(`
      SELECT id, admin_id AS adminId, action, target_id AS targetId, amount, currency, reason, created_at AS createdAt
      FROM admin_logs
      WHERE admin_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `),
    pruneAdminLogs: db.prepare(`
      DELETE FROM admin_logs
      WHERE rowid NOT IN (
        SELECT rowid FROM admin_logs ORDER BY created_at DESC LIMIT ?
      )
    `),
    getTransactionByRequestId: db.prepare(`
      SELECT id, type, user_id AS userId, admin_id AS adminId, delta_bjt AS deltaBjt,
             delta_stars AS deltaStars, balance_bjt AS bjt, balance_stars AS stars,
             currency, amount, reason, request_id AS requestId, created_at AS createdAt
      FROM currency_transactions
      WHERE request_id = ?
    `),
    insertTransaction: db.prepare(`
      INSERT INTO currency_transactions (
        id, type, user_id, admin_id, delta_bjt, delta_stars, balance_bjt, balance_stars,
        currency, amount, reason, request_id, created_at
      ) VALUES (
        :id, :type, :userId, :adminId, :deltaBjt, :deltaStars, :balanceBjt, :balanceStars,
        :currency, :amount, :reason, :requestId, :createdAt
      )
    `),
    transactions: db.prepare(`
      SELECT id, type, user_id AS userId, admin_id AS adminId, delta_bjt AS deltaBjt,
             delta_stars AS deltaStars, balance_bjt AS bjt, balance_stars AS stars,
             currency, amount, reason, request_id AS requestId, created_at AS createdAt
      FROM currency_transactions
      ORDER BY created_at DESC
      LIMIT ?
    `),
    transactionsByUser: db.prepare(`
      SELECT id, type, user_id AS userId, admin_id AS adminId, delta_bjt AS deltaBjt,
             delta_stars AS deltaStars, balance_bjt AS bjt, balance_stars AS stars,
             currency, amount, reason, request_id AS requestId, created_at AS createdAt
      FROM currency_transactions
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `),
    pruneTransactions: db.prepare(`
      DELETE FROM currency_transactions
      WHERE rowid NOT IN (
        SELECT rowid FROM currency_transactions ORDER BY created_at DESC LIMIT ?
      )
    `)
  };
}

function migrateLegacyJsonOnce() {
  if (!fs.existsSync(legacyJsonPath)) return;
  if (statements.countMessages.get().count > 0 || statements.countBalances.get().count > 0) return;

  try {
    const legacy = JSON.parse(fs.readFileSync(legacyJsonPath, 'utf-8'));
    withTransaction(() => {
      if (Array.isArray(legacy.messages)) {
        legacy.messages.forEach((message) => saveMessageInternal(normalizeMessageRecord(message)));
      }

      if (legacy.balances && typeof legacy.balances === 'object') {
        for (const [userId, balance] of Object.entries(legacy.balances)) {
          const id = safeUserId(userId);
          if (!id) continue;
          setBalanceInternal(id, safeCurrency(balance?.bjt), safeCurrency(balance?.stars));
        }
      }

      if (Array.isArray(legacy.adminLogs)) {
        legacy.adminLogs.forEach((log) => {
          const targetId = safeUserId(log?.targetId);
          const adminId = safeUserId(log?.adminId);
          const amount = safeCurrency(log?.amount);
          const currency = log?.currency === 'stars' ? 'stars' : 'bjt';
          if (!adminId || !targetId) return;
          insertAdminLogInternal({
            adminId,
            action: String(log?.action || 'legacy'),
            targetId,
            amount,
            currency,
            reason: String(log?.reason || 'Imported from JSON').slice(0, 200),
            createdAt: validDate(log?.createdAt)
          });
        });
      }
    });
    console.log('✅ Legacy JSON data migrated to SQLite');
  } catch (error) {
    console.warn('⚠️  Legacy JSON migration skipped:', error.message);
  }
}

export function saveMessage(message) {
  saveMessageInternal(normalizeMessageRecord(message));
  statements.pruneMessages.run(MAX_STORED_MESSAGES);
}

function saveMessageInternal(message) {
  statements.insertMessage.run(message);
}

export function getRecentMessages(limit = 100) {
  const safeLimit = clampInt(limit, 1, 500, 100);
  return statements.recentMessages.all(safeLimit).reverse().map(rowToMessage);
}

export function cleanOldMessages(daysOld = 30) {
  const safeDays = clampInt(daysOld, 1, 3650, 30);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - safeDays);
  return statements.deleteOldMessages.run(cutoff.toISOString()).changes;
}

export function getBalance(userId, defaultBjt = DEFAULT_BJT) {
  const id = safeUserId(userId);
  if (!id) return { bjt: 0, stars: 0 };

  const found = statements.getBalance.get(id);
  if (found) return { bjt: found.bjt, stars: found.stars };

  const adminId = Number(process.env.VK_ADMIN_ID || 1057236881);
  const initialBjt = id === adminId ? ADMIN_INITIAL_BJT : defaultBjt;
  setBalanceInternal(id, safeCurrency(initialBjt), 0);
  return { bjt: safeCurrency(initialBjt), stars: 0 };
}

export function setBalance(userId, bjt, stars) {
  const id = safeUserId(userId);
  if (!id) throw new Error('Invalid user id');
  setBalanceInternal(id, safeCurrency(bjt), safeCurrency(stars));
}

function setBalanceInternal(userId, bjt, stars) {
  statements.upsertBalance.run(userId, bjt, stars, new Date().toISOString());
}

export function updateBalance(userId, bjt = 0, stars = 0) {
  const id = safeUserId(userId);
  if (!id) throw new Error('Invalid user id');

  return withTransaction(() => {
    const balance = getBalance(id);
    const nextBjt = Math.max(0, safeCurrency(balance.bjt + Number(bjt || 0)));
    const nextStars = Math.max(0, safeCurrency(balance.stars + Number(stars || 0)));
    setBalanceInternal(id, nextBjt, nextStars);
    return { bjt: nextBjt, stars: nextStars };
  });
}

export function convertBjtToStars(userId, bjtAmount, requestId = null) {
  const user = safeUserId(userId);
  const amount = safeCurrency(bjtAmount);
  if (!user || amount <= 0) throw new Error('Invalid conversion');

  return withTransaction(() => {
    if (requestId) {
      const existing = statements.getTransactionByRequestId.get(String(requestId).slice(0, 120));
      if (existing) return { balance: { bjt: existing.bjt, stars: existing.stars }, transactionId: existing.id, duplicate: true };
    }

    const balance = getBalance(user);
    if (balance.bjt < amount) {
      return { error: 'Недостаточно BJT', balance };
    }

    const nextBjt = balance.bjt - amount;
    const nextStars = balance.stars + amount * 2;
    setBalanceInternal(user, nextBjt, nextStars);

    const transactionId = insertCurrencyTransaction({
      type: 'convert',
      userId: user,
      adminId: null,
      deltaBjt: -amount,
      deltaStars: amount * 2,
      balanceBjt: nextBjt,
      balanceStars: nextStars,
      currency: 'bjt',
      amount,
      reason: 'Конвертация BJT в звёзды',
      requestId
    });

    return { balance: { bjt: nextBjt, stars: nextStars }, transactionId, duplicate: false };
  });
}

export function grantCurrency({ adminId, targetId, amount, currency = 'bjt', reason = '', requestId = null }) {
  const admin = safeUserId(adminId);
  const target = safeUserId(targetId);
  const safeAmount = safeCurrency(amount);
  const safeCurrencyName = currency === 'stars' ? 'stars' : 'bjt';
  const safeReason = String(reason || 'Admin grant').slice(0, 200);
  const safeRequestId = requestId ? String(requestId).slice(0, 120) : null;

  if (!admin || !target || safeAmount <= 0) throw new Error('Invalid grant payload');

  return withTransaction(() => {
    if (safeRequestId) {
      const existing = statements.getTransactionByRequestId.get(safeRequestId);
      if (existing) return {
        balance: { bjt: existing.bjt, stars: existing.stars },
        transactionId: existing.id,
        adminLogId: null,
        duplicate: true
      };
    }

    const balance = getBalance(target);
    const nextBjt = safeCurrencyName === 'bjt' ? balance.bjt + safeAmount : balance.bjt;
    const nextStars = safeCurrencyName === 'stars' ? balance.stars + safeAmount : balance.stars;
    setBalanceInternal(target, nextBjt, nextStars);

    const adminLogId = insertAdminLogInternal({
      adminId: admin,
      action: 'grant',
      targetId: target,
      amount: safeAmount,
      currency: safeCurrencyName,
      reason: safeReason
    });

    const transactionId = insertCurrencyTransaction({
      type: 'grant',
      userId: target,
      adminId: admin,
      deltaBjt: safeCurrencyName === 'bjt' ? safeAmount : 0,
      deltaStars: safeCurrencyName === 'stars' ? safeAmount : 0,
      balanceBjt: nextBjt,
      balanceStars: nextStars,
      currency: safeCurrencyName,
      amount: safeAmount,
      reason: safeReason,
      requestId: safeRequestId
    });

    pruneCurrencyData();
    return {
      balance: { bjt: nextBjt, stars: nextStars },
      transactionId,
      adminLogId,
      duplicate: false
    };
  });
}

export function logAdminAction(adminId, action, targetId, amount, currency, reason = '') {
  const id = insertAdminLogInternal({ adminId, action, targetId, amount, currency, reason });
  statements.pruneAdminLogs.run(MAX_ADMIN_LOGS);
  return id;
}

function insertAdminLogInternal({ adminId, action, targetId, amount, currency, reason = '', createdAt = new Date().toISOString() }) {
  const id = crypto.randomUUID();
  statements.insertAdminLog.run({
    id,
    adminId: safeUserId(adminId),
    action: String(action || 'unknown').slice(0, 60),
    targetId: safeUserId(targetId),
    amount: safeCurrency(amount),
    currency: currency === 'stars' ? 'stars' : 'bjt',
    reason: String(reason || '').slice(0, 200),
    createdAt: validDate(createdAt)
  });
  return id;
}

function insertCurrencyTransaction({
  type,
  userId,
  adminId = null,
  deltaBjt = 0,
  deltaStars = 0,
  balanceBjt,
  balanceStars,
  currency,
  amount = 0,
  reason = '',
  requestId = null
}) {
  const id = crypto.randomUUID();
  statements.insertTransaction.run({
    id,
    type,
    userId: safeUserId(userId),
    adminId: adminId ? safeUserId(adminId) : null,
    deltaBjt: Math.floor(Number(deltaBjt || 0)),
    deltaStars: Math.floor(Number(deltaStars || 0)),
    balanceBjt: safeCurrency(balanceBjt),
    balanceStars: safeCurrency(balanceStars),
    currency: currency === 'stars' ? 'stars' : 'bjt',
    amount: safeCurrency(amount),
    reason: String(reason || '').slice(0, 200),
    requestId: requestId ? String(requestId).slice(0, 120) : null,
    createdAt: new Date().toISOString()
  });
  statements.pruneTransactions.run(MAX_TRANSACTIONS);
  return id;
}

function pruneCurrencyData() {
  statements.pruneAdminLogs.run(MAX_ADMIN_LOGS);
  statements.pruneTransactions.run(MAX_TRANSACTIONS);
}

export function getAdminLogs(limit = 50, adminId = null) {
  const safeLimit = clampInt(limit, 1, 500, 50);
  if (adminId) return statements.adminLogsByAdmin.all(safeUserId(adminId), safeLimit);
  return statements.adminLogs.all(safeLimit);
}

export function getTransactions(limit = 50, userId = null) {
  const safeLimit = clampInt(limit, 1, 500, 50);
  if (userId) return statements.transactionsByUser.all(safeUserId(userId), safeLimit);
  return statements.transactions.all(safeLimit);
}

export function getDatabaseInfo() {
  return {
    driver: 'sqlite',
    path: sqlitePath,
    maxStoredMessages: MAX_STORED_MESSAGES,
    maxAdminLogs: MAX_ADMIN_LOGS,
    maxTransactions: MAX_TRANSACTIONS,
    counts: {
      messages: statements.countMessages.get().count,
      balances: statements.countBalances.get().count,
      adminLogs: statements.countAdminLogs.get().count,
      transactions: statements.countTransactions.get().count
    }
  };
}

function withTransaction(callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function normalizeMessageRecord(message) {
  return {
    id: String(message?.id || crypto.randomUUID()),
    userId: safeUserId(message?.userId || message?.user_id || 0, true),
    name: String(message?.name || 'Гость').slice(0, 140),
    avatar: String(message?.avatar || '/assets/splash.jpg').slice(0, 500),
    text: String(message?.text || '').slice(0, 1000),
    createdAt: validDate(message?.createdAt || message?.created_at),
    system: message?.system ? 1 : 0
  };
}

function rowToMessage(row) {
  return {
    ...row,
    system: Boolean(row.system)
  };
}

function safeUserId(value, allowSystem = false) {
  const id = Number(value);
  if (allowSystem && id === 0) return 0;
  if (!Number.isFinite(id) || id <= 0) return 0;
  return Math.floor(id);
}

function safeCurrency(value) {
  const amount = Math.floor(Number(value));
  if (!Number.isFinite(amount) || amount < 0) return 0;
  return Math.min(amount, 1_000_000_000);
}

function clampInt(value, min, max, fallback) {
  const int = Math.floor(Number(value));
  if (!Number.isFinite(int)) return fallback;
  return Math.min(max, Math.max(min, int));
}

function validDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

export default {
  initializeDatabase,
  saveMessage,
  getRecentMessages,
  cleanOldMessages,
  getBalance,
  setBalance,
  updateBalance,
  convertBjtToStars,
  grantCurrency,
  logAdminAction,
  getAdminLogs,
  getTransactions,
  getDatabaseInfo
};
