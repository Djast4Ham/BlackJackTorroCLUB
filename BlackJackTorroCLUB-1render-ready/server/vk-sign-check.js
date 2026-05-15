import crypto from 'node:crypto';

const DEFAULT_MAX_AGE_SECONDS = 48 * 60 * 60;

/**
 * Проверка подписи VK launch-параметров.
 * Возвращает true только если HMAC подпись совпала.
 */
export function verifyVKSignature(queryString, clientSecret) {
  if (!queryString || !clientSecret) return false;

  const params = new URLSearchParams(queryString);
  const signature = params.get('sign');
  if (!signature) return false;

  params.delete('sign');

  const sortedEntries = Array.from(params.entries())
    .filter(([key]) => key.startsWith('vk_'))
    .sort(([a], [b]) => a.localeCompare(b));

  if (!sortedEntries.length) return false;

  const sortedParams = new URLSearchParams(sortedEntries).toString();
  const hash = crypto
    .createHmac('sha256', clientSecret)
    .update(sortedParams)
    .digest('base64');

  const computedSignature = normalizeBase64Url(hash);
  const receivedSignature = normalizeBase64Url(signature);

  const computedBuffer = Buffer.from(computedSignature);
  const receivedBuffer = Buffer.from(receivedSignature);

  if (computedBuffer.length !== receivedBuffer.length) return false;
  return crypto.timingSafeEqual(computedBuffer, receivedBuffer);
}

export function extractVKUserId(queryString) {
  try {
    const params = new URLSearchParams(queryString);
    const userId = Number(params.get('vk_user_id'));
    return Number.isFinite(userId) && userId > 0 ? Math.floor(userId) : null;
  } catch {
    return null;
  }
}

export function extractVKAppId(queryString) {
  try {
    const params = new URLSearchParams(queryString);
    const appId = Number(params.get('vk_app_id'));
    return Number.isFinite(appId) && appId > 0 ? Math.floor(appId) : null;
  } catch {
    return null;
  }
}

export function validateVKLaunchParams(queryString, clientSecret, options = {}) {
  if (!queryString) return null;

  const params = new URLSearchParams(queryString);
  const userId = extractVKUserId(queryString);
  const appId = extractVKAppId(queryString);
  const expectedAppId = Number(options.appId || process.env.VK_APP_ID || 54584981);
  const maxAgeSeconds = Number(options.maxAgeSeconds || process.env.VK_SIGN_MAX_AGE_SECONDS || DEFAULT_MAX_AGE_SECONDS);
  const ts = Number(params.get('vk_ts'));

  if (!userId) return null;

  const signatureValid = verifyVKSignature(queryString, clientSecret);
  const appValid = !expectedAppId || appId === expectedAppId;
  const tsValid = !Number.isFinite(ts) || maxAgeSeconds <= 0
    ? true
    : Math.abs(Math.floor(Date.now() / 1000) - ts) <= maxAgeSeconds;

  const valid = Boolean(signatureValid && appValid && tsValid);

  return {
    userId,
    appId,
    expectedAppId,
    signatureValid,
    appValid,
    tsValid,
    valid,
    reason: valid
      ? null
      : !signatureValid
        ? 'invalid_signature'
        : !appValid
          ? 'wrong_app_id'
          : 'stale_launch_params'
  };
}

function normalizeBase64Url(value) {
  return String(value || '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}
