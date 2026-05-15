import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { validateVKLaunchParams } from './vk-sign-check.js';
import {
  initializeDatabase,
  getRecentMessages,
  saveMessage,
  getBalance,
  convertBjtToStars,
  grantCurrency,
  getAdminLogs,
  getTransactions,
  getDatabaseInfo
} from './db.js';
import {
  sanitizeText,
  validateMessage,
  validateUserData,
  validateCurrencyAmount,
  validateUserId
} from './sanitize.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 3001);
const VK_APP_ID = Number(process.env.VK_APP_ID || 54584981);
const ADMIN_ID = Number(process.env.VK_ADMIN_ID || 1057236881);
const rawVKClientSecret = String(process.env.VK_CLIENT_SECRET || '').trim();
const VK_CLIENT_SECRET = isPlaceholderSecret(rawVKClientSecret) ? '' : rawVKClientSecret;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const MAX_MESSAGES = 100;
const MAX_REASON_LENGTH = 200;
const CLIENT_URLS = (process.env.CLIENT_URL || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const VK_MAX_AGE_SECONDS = Number(process.env.VK_SIGN_MAX_AGE_SECONDS || 48 * 60 * 60);

initializeDatabase();

const usersBySocket = new Map();
const socketsByUser = new Map();
const socketRateLimits = new Map();

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors({ origin: validateCorsOrigin, credentials: true }));
app.use(express.json({ limit: '64kb' }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов, попробуйте позже' }
});

const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов, попробуйте позже' }
});

app.use('/api/', apiLimiter);
app.use(['/api/vk-check', '/api/admin'], strictLimiter);
app.use(attachVKValidationFromRequest);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: validateCorsOrigin, credentials: true },
  path: '/socket.io',
  maxHttpBufferSize: 16 * 1024
});

io.use(attachVKValidationFromSocket);

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    app: 'БАР Знакомств!',
    vkAppId: VK_APP_ID,
    adminId: ADMIN_ID,
    vkSignatureCheckEnabled: !!VK_CLIENT_SECRET,
    productionMode: IS_PRODUCTION,
    database: getDatabaseInfo()
  });
});

app.get('/api/vk-check', (request, response) => {
  if (!VK_CLIENT_SECRET) {
    return response.status(IS_PRODUCTION ? 503 : 400).json({
      error: 'VK_CLIENT_SECRET not configured on server',
      userId: null,
      appId: VK_APP_ID,
      valid: false
    });
  }

  if (!request.vkValidation) {
    return response.status(400).json({
      error: 'VK launch parameters are missing',
      userId: null,
      appId: VK_APP_ID,
      valid: false
    });
  }

  return response.json({
    userId: request.vkValidation.userId,
    appId: request.vkValidation.appId,
    expectedAppId: VK_APP_ID,
    valid: request.vkValidation.valid,
    reason: request.vkValidation.reason,
    warning: !request.vkValidation.valid ? 'Invalid VK launch parameters - possible spoofing attempt' : null
  });
});

app.get('/api/economy', (_request, response) => {
  response.json({
    rates: {
      vkVoice: { bjt: 10, voices: 1, rub: 7 },
      stars: { bjt: 10, stars: 20 }
    },
    limits: {
      maxAdminGrant: 1000000,
      maxChatMessageBytes: 500
    }
  });
});

app.get('/api/admin/logs', requireHttpAdmin, (request, response) => {
  const limit = clampInt(request.query.limit, 1, 100, 50);
  response.json({
    adminLogs: getAdminLogs(limit),
    transactions: getTransactions(limit)
  });
});

const distDir = path.join(rootDir, 'dist');
app.use(express.static(distDir));
app.get('*', (_request, response, next) => {
  const indexPath = path.join(distDir, 'index.html');
  response.sendFile(indexPath, (error) => {
    if (error) next();
  });
});

io.on('connection', (socket) => {
  socket.on('user:join', (payload) => {
    const user = normalizeUser(payload, socket.vkValidation);
    if (!user) {
      socket.emit('app:error', { code: 'auth_required', message: 'Не удалось подтвердить пользователя' });
      return;
    }

    const previousUser = usersBySocket.get(socket.id);
    if (previousUser && previousUser.id !== user.id) {
      removeSocketFromUser(previousUser.id, socket.id);
    }

    user.joinedAt = previousUser?.id === user.id ? previousUser.joinedAt : new Date().toISOString();
    usersBySocket.set(socket.id, user);

    if (!socketsByUser.has(user.id)) socketsByUser.set(user.id, new Set());
    socketsByUser.get(user.id).add(socket.id);

    const messages = getRecentMessages(MAX_MESSAGES);
    const balance = getBalance(user.id);
    const users = getConnectedUsers();

    socket.emit('state:init', { messages, balance, users });
    broadcastUsers();
  });

  socket.on('chat:send', (payload, ack) => {
    const user = usersBySocket.get(socket.id);
    if (!user) return ackError(ack, 'auth_required', 'Сначала войдите в бар');

    if (!checkRateLimit(user.id, 'message', 10)) {
      socket.emit('app:error', { code: 'rate_limit', message: 'Слишком много сообщений, подождите' });
      return ackError(ack, 'rate_limit', 'Слишком много сообщений, подождите');
    }

    const validated = validateMessage(payload);
    if (!validated) return ackError(ack, 'bad_message', 'Сообщение пустое или слишком длинное');

    const message = {
      id: crypto.randomUUID(),
      userId: user.id,
      name: displayName(user),
      avatar: user.photo_100,
      text: validated.text,
      createdAt: new Date().toISOString()
    };

    saveMessage(message);
    io.emit('chat:message', message);
    ackOk(ack, { messageId: message.id });
  });

  socket.on('shop:convert', (payload, ack) => {
    const user = usersBySocket.get(socket.id);
    if (!user) return ackError(ack, 'auth_required', 'Сначала войдите в бар');

    if (!checkRateLimit(user.id, 'convert', 5)) {
      socket.emit('app:error', { code: 'rate_limit', message: 'Слишком много конвертаций, подождите' });
      return ackError(ack, 'rate_limit', 'Слишком много конвертаций, подождите');
    }

    const bjt = validateCurrencyAmount(payload?.bjt);
    const requestId = sanitizeRequestId(payload?.requestId);
    if (bjt === null) return ackError(ack, 'bad_amount', 'Неверная сумма');

    const result = convertBjtToStars(user.id, bjt, requestId);
    if (result.error) return ackError(ack, 'not_enough_balance', result.error, { balance: result.balance });

    emitBalance(user.id, result.balance);
    ackOk(ack, result);
  });

  socket.on('admin:grant', (payload, ack) => {
    const admin = usersBySocket.get(socket.id);
    if (!isTrustedAdmin(admin)) {
      console.warn(`⚠️ SECURITY: blocked admin:grant from socket ${socket.id}`);
      socket.emit('app:error', { code: 'admin_forbidden', message: 'Нет прав администратора' });
      return ackError(ack, 'admin_forbidden', 'Нет прав администратора');
    }

    if (!checkRateLimit(admin.id, 'admin_grant', 30)) {
      return ackError(ack, 'rate_limit', 'Слишком много начислений, подождите');
    }

    const targetId = validateUserId(payload?.targetId);
    const amount = validateCurrencyAmount(payload?.amount);
    const currency = payload?.currency === 'stars' ? 'stars' : 'bjt';
    const reason = sanitizeText(payload?.reason || 'Подарок тестеру', MAX_REASON_LENGTH);
    const requestId = sanitizeRequestId(payload?.requestId) || `${socket.id}:${Date.now()}:${crypto.randomUUID()}`;

    if (targetId === null || amount === null) return ackError(ack, 'bad_payload', 'Проверь VK ID и сумму');

    try {
      const result = grantCurrency({ adminId: admin.id, targetId, amount, currency, reason, requestId });
      emitBalance(targetId, result.balance);

      const adminMessage = {
        id: crypto.randomUUID(),
        userId: 0,
        name: 'Админ-панель',
        avatar: '/assets/splash.jpg',
        text: result.duplicate
          ? `Повторное начисление заблокировано: ${amount} ${currency === 'bjt' ? 'BJT' : 'звёзд'} для VK ID ${targetId} уже учтено.`
          : `Начислено ${amount} ${currency === 'bjt' ? 'BJT' : 'звёзд'} для VK ID ${targetId}.`,
        createdAt: new Date().toISOString(),
        system: true
      };

      saveMessage(adminMessage);
      io.to(socket.id).emit('chat:message', adminMessage);
      ackOk(ack, result);
    } catch (error) {
      console.warn('⚠️ admin:grant failed:', error.message);
      ackError(ack, 'grant_failed', 'Не удалось начислить валюту');
    }
  });

  socket.on('admin:logs', (payload, ack) => {
    const admin = usersBySocket.get(socket.id);
    if (!isTrustedAdmin(admin)) return ackError(ack, 'admin_forbidden', 'Нет прав администратора');
    const limit = clampInt(payload?.limit, 1, 100, 30);
    ackOk(ack, { adminLogs: getAdminLogs(limit), transactions: getTransactions(limit) });
  });

  socket.on('disconnect', () => {
    const user = usersBySocket.get(socket.id);
    usersBySocket.delete(socket.id);
    if (!user) return;
    removeSocketFromUser(user.id, socket.id);
    broadcastUsers();
  });
});


function isPlaceholderSecret(value) {
  if (!value) return true;
  const normalized = value.toLowerCase();
  return normalized === 'replace_with_client_secret'
    || normalized === 'replace-with-client-secret'
    || normalized === 'your_client_secret'
    || normalized.includes('replace_with')
    || normalized.includes('changeme');
}

function attachVKValidationFromRequest(req, _res, next) {
  if (VK_CLIENT_SECRET) {
    const queryString = getRawQueryString(req.originalUrl);
    const validation = validateVKLaunchParams(queryString, VK_CLIENT_SECRET, {
      appId: VK_APP_ID,
      maxAgeSeconds: VK_MAX_AGE_SECONDS
    });

    if (validation && !validation.valid) {
      console.warn(`⚠️ SECURITY: Invalid VK HTTP launch params. VK ID: ${validation.userId}; reason: ${validation.reason}`);
    }

    req.vkValidation = validation;
  }
  next();
}

function attachVKValidationFromSocket(socket, next) {
  if (VK_CLIENT_SECRET) {
    const launchParams = typeof socket.handshake.auth?.launchParams === 'string'
      ? socket.handshake.auth.launchParams
      : '';
    const validation = validateVKLaunchParams(launchParams, VK_CLIENT_SECRET, {
      appId: VK_APP_ID,
      maxAgeSeconds: VK_MAX_AGE_SECONDS
    });

    if (!validation?.valid) {
      console.warn(`⚠️ SECURITY: Invalid VK socket launch params. VK ID: ${validation?.userId || 'unknown'}; reason: ${validation?.reason || 'missing'}`);
      if (IS_PRODUCTION) return next(new Error('VK signature required'));
    }

    socket.vkValidation = validation;
  } else if (IS_PRODUCTION) {
    console.error('❌ SECURITY: VK_CLIENT_SECRET is required in production');
    return next(new Error('Server auth is not configured'));
  }

  next();
}

function requireHttpAdmin(request, response, next) {
  if (!VK_CLIENT_SECRET && !IS_PRODUCTION) return next();
  const validation = request.vkValidation;
  if (!validation?.valid || Number(validation.userId) !== ADMIN_ID) {
    return response.status(403).json({ error: 'Нет прав администратора' });
  }
  return next();
}

function getRawQueryString(originalUrl = '') {
  const queryIndex = originalUrl.indexOf('?');
  return queryIndex === -1 ? '' : originalUrl.slice(queryIndex + 1);
}

function validateCorsOrigin(origin, callback) {
  if (!origin) return callback(null, true);
  if (CLIENT_URLS.includes(origin)) return callback(null, true);
  if (!IS_PRODUCTION && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return callback(null, true);
  }
  return callback(new Error('CORS origin is not allowed'));
}

function isTrustedAdmin(user) {
  if (!user || Number(user.id) !== ADMIN_ID) return false;
  if (!VK_CLIENT_SECRET) return !IS_PRODUCTION;
  return user.vkValid === true;
}

function checkRateLimit(userId, action = 'message', maxPerMinute = 10) {
  const key = `${userId}:${action}`;
  const now = Date.now();
  const limit = socketRateLimits.get(key);

  if (!limit || now > limit.resetTime) {
    socketRateLimits.set(key, { count: 1, resetTime: now + 60000 });
    cleanupSocketRateLimits(now);
    return true;
  }

  if (limit.count >= maxPerMinute) return false;
  limit.count++;
  return true;
}

function cleanupSocketRateLimits(now) {
  if (socketRateLimits.size < 1000) return;
  for (const [key, limit] of socketRateLimits.entries()) {
    if (now > limit.resetTime) socketRateLimits.delete(key);
  }
}

function removeSocketFromUser(userId, socketId) {
  const sockets = socketsByUser.get(Number(userId));
  if (!sockets) return;
  sockets.delete(socketId);
  if (!sockets.size) socketsByUser.delete(Number(userId));
}

function getConnectedUsers() {
  const map = new Map();
  for (const [, user] of usersBySocket) {
    if (!map.has(user.id)) map.set(user.id, user);
  }
  return Array.from(map.values());
}

function broadcastUsers() {
  io.emit('users:update', getConnectedUsers());
}

function emitBalance(userId, balance = null) {
  const sockets = socketsByUser.get(Number(userId));
  if (!sockets) return;
  const nextBalance = balance || getBalance(userId);
  for (const socketId of sockets) io.to(socketId).emit('wallet:update', nextBalance);
}

function normalizeUser(raw, vkValidation = null) {
  const validated = validateUserData(raw);

  if (VK_CLIENT_SECRET) {
    if (!vkValidation?.valid || !vkValidation.userId) return null;
    return {
      ...(validated || {}),
      id: Number(vkValidation.userId),
      first_name: validated?.first_name || 'Пользователь',
      last_name: validated?.last_name || '',
      photo_100: validated?.photo_100 || '/assets/splash.jpg',
      vkValid: true
    };
  }

  if (IS_PRODUCTION) return null;

  return validated || {
    id: Math.floor(100000000 + Math.random() * 900000000),
    first_name: 'Гость',
    last_name: '',
    photo_100: '/assets/splash.jpg',
    vkValid: false
  };
}

function displayName(user) {
  return `${user.first_name} ${user.last_name}`.trim() || 'Гость';
}

function sanitizeRequestId(value) {
  if (typeof value !== 'string') return null;
  const clean = value.trim().replace(/[^a-zA-Z0-9:_-]/g, '').slice(0, 120);
  return clean || null;
}

function ackOk(ack, payload = {}) {
  if (typeof ack === 'function') ack({ ok: true, ...payload });
}

function ackError(ack, code, message, extra = {}) {
  if (typeof ack === 'function') ack({ ok: false, code, message, ...extra });
}

function clampInt(value, min, max, fallback) {
  const int = Math.floor(Number(value));
  if (!Number.isFinite(int)) return fallback;
  return Math.min(max, Math.max(min, int));
}

server.listen(PORT, () => {
  console.log(`\n🎉 БАР Знакомств! server running on http://localhost:${PORT}`);
  console.log(`✅ VK Mini App ID: ${VK_APP_ID}`);
  console.log(`✅ Admin VK ID: ${ADMIN_ID}`);
  if (VK_CLIENT_SECRET) {
    console.log('✅ VK signature check: ENABLED');
  } else {
    console.log('⚠️  VK signature check: DISABLED (VK_CLIENT_SECRET not set in .env)');
  }
  console.log(`✅ Database: SQLite (${getDatabaseInfo().path})`);
  console.log('✅ Security: Helmet + CORS allow-list + rate-limiting + server-side VK auth + transaction journal');
  console.log('');
});
