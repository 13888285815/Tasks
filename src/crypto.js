/**
 * 对话记录加密模块
 * 算法：AES-256-GCM（认证加密，防篡改）
 * 密钥来源：环境变量 ENCRYPT_KEY（32 字节 hex）
 *           未设置时自动生成并提示
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_LEN = 32;   // 256-bit
const IV_LEN = 12;    // GCM 推荐 96-bit
const TAG_LEN = 16;

// =================== 密钥管理 ===================

let _encryptionKey = null;

function getEncryptionKey() {
  if (_encryptionKey) return _encryptionKey;

  const envKey = process.env.ENCRYPT_KEY;

  if (envKey) {
    if (!/^[0-9a-f]{64}$/i.test(envKey)) {
      throw new Error('[CRYPTO] ENCRYPT_KEY 格式错误，需要 64 位 hex 字符串（32字节）');
    }
    _encryptionKey = Buffer.from(envKey, 'hex');
    console.log('[CRYPTO] ✅ 使用环境变量加密密钥');
  } else {
    // 生产环境强制要求设置环境变量
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[CRYPTO] 生产环境必须设置 ENCRYPT_KEY 环境变量！');
    }
    // 开发环境：生成确定性密钥（基于机器标识）并警告
    const machineId = require('os').hostname() + require('os').userInfo().username;
    _encryptionKey = crypto.scryptSync(machineId, 'cs-agent-salt-v1', KEY_LEN);
    console.warn('[CRYPTO] ⚠️  未设置 ENCRYPT_KEY，使用机器衍生密钥（仅适用开发环境）');
    console.warn('[CRYPTO]    生产环境请设置：ENCRYPT_KEY=' + generateKey());
  }

  return _encryptionKey;
}

/**
 * 生成随机 256-bit 加密密钥（hex 格式）
 */
function generateKey() {
  return crypto.randomBytes(KEY_LEN).toString('hex');
}

// =================== 加密 / 解密 ===================

/**
 * 加密字符串
 * @param {string} plaintext
 * @returns {string}  "iv:ciphertext:tag" base64 格式
 */
function encrypt(plaintext) {
  if (!plaintext && plaintext !== '') return plaintext;

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LEN });

  const encrypted = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  // 格式：base64(iv) + ':' + base64(ciphertext) + ':' + base64(tag)
  return [
    iv.toString('base64'),
    encrypted.toString('base64'),
    tag.toString('base64')
  ].join(':');
}

/**
 * 解密字符串
 * @param {string} cipherData  "iv:ciphertext:tag" 格式
 * @returns {string}
 */
function decrypt(cipherData) {
  if (!cipherData || typeof cipherData !== 'string') return cipherData;

  // 未加密的旧数据（不含冒号分隔的三段）直接返回原文
  const parts = cipherData.split(':');
  if (parts.length !== 3) return cipherData;

  try {
    const key = getEncryptionKey();
    const iv = Buffer.from(parts[0], 'base64');
    const encrypted = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LEN });
    decipher.setAuthTag(tag);

    return decipher.update(encrypted) + decipher.final('utf8');
  } catch (e) {
    console.error('[CRYPTO] 解密失败（数据可能被篡改或密钥不匹配）:', e.message);
    return '[解密失败]';
  }
}

// =================== 对象级别加密（只加密敏感字段）===================

const SENSITIVE_FIELDS = ['content', 'userId'];

/**
 * 加密消息对象中的敏感字段
 */
function encryptMessage(msg) {
  if (!msg) return msg;
  const result = { ...msg };
  for (const field of SENSITIVE_FIELDS) {
    if (field in result && result[field] != null) {
      result[field] = encrypt(String(result[field]));
    }
  }
  return result;
}

/**
 * 解密消息对象中的敏感字段
 */
function decryptMessage(msg) {
  if (!msg) return msg;
  const result = { ...msg };
  for (const field of SENSITIVE_FIELDS) {
    if (field in result && result[field] != null) {
      result[field] = decrypt(String(result[field]));
    }
  }
  return result;
}

/**
 * 批量解密消息列表
 */
function decryptMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map(decryptMessage);
}

module.exports = {
  encrypt,
  decrypt,
  encryptMessage,
  decryptMessage,
  decryptMessages,
  generateKey,
  SENSITIVE_FIELDS
};
