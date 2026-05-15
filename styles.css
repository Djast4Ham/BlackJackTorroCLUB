/**
 * Комплексная санитизация текста
 * - Удаляет HTML теги и опасные символы
 * - Удаляет контрольные символы
 * - Ограничивает длину
 * @param {string} value - Текст для санитизации
 * @param {number} maxLength - Максимальная длина
 * @returns {string} Санитизированный текст
 */
export function sanitizeText(value, maxLength = 500) {
  if (typeof value !== 'string') return '';

  let text = value
    // Удалить HTML теги
    .replace(/<[^>]*>/g, '')
    // Удалить контрольные символы (кроме перевода строки)
    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '')
    // Удалить опасные символы
    .replace(/[<>\"']/g, '')
    // Удалить множественные пробелы
    .replace(/\s+/g, ' ')
    .trim();

  // Ограничить длину в байтах UTF-8
  return truncateUtf8(text, maxLength);
}

/**
 * Безопасно обрезать UTF-8 строку без нарушения многобайтовых символов
 */
function truncateUtf8(str, maxBytes) {
  const encoder = new TextEncoder();
  let result = '';

  for (const char of str) {
    if (encoder.encode(result + char).length > maxBytes) return result;
    result += char;
  }

  return result;
}

/**
 * Санитизация имени пользователя
 */
export function sanitizeName(value, maxLength = 100) {
  if (typeof value !== 'string') return '';
  
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[<>\"']/g, '')
    .trim()
    .slice(0, maxLength);
}

/**
 * Санитизация URL (аватара)
 */
export function sanitizeUrl(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();

  if (trimmed.startsWith('/assets/')) return trimmed;

  try {
    const url = new URL(trimmed);
    // Для внешних аватаров разрешаем только HTTPS
    if (url.protocol !== 'https:') return '';
    return url.toString();
  } catch {
    return '';
  }
}

/**
 * Валидация типов данных
 */
export function validateMessage(payload) {
  if (!payload || typeof payload !== 'object') return null;
  
  const text = sanitizeText(payload.text, 500);
  if (!text) return null;
  
  return { text };
}

export function validateUserData(payload) {
  if (!payload || typeof payload !== 'object') return null;
  
  const id = Number(payload.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  
  return {
    id,
    first_name: sanitizeName(payload.first_name, 60),
    last_name: sanitizeName(payload.last_name, 60),
    photo_100: sanitizeUrl(payload.photo_100) || '/assets/splash.jpg'
  };
}

export function validateCurrencyAmount(value) {
  const amount = Math.floor(Number(value));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.min(amount, 1000000); // Макс 1 млн
}

export function validateUserId(value) {
  const id = Number(value);
  if (!Number.isFinite(id) || id <= 0) return null;
  return id;
}
