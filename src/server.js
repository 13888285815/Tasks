/**
 * Express 服务器主入口
 * 智能客服 Agent Web 应用
 *
 * 安全加固版 v2.0：
 *  - helmet 安全响应头（CSP / HSTS / X-Frame-Options 等）
 *  - CORS 白名单（非 * 通配）
 *  - 登录接口限流（10次/15分钟）
 *  - bcrypt 密码哈希验证
 *  - 输入长度 / 类型校验
 *  - 错误信息脱敏（不暴露栈追踪）
 *  - AES-256-GCM 对话记录加密（见 crypto.js）
 *  - Session cookie: httpOnly + sameSite=strict
 *  - /api/chat/history 需鉴权
 */

const express  = require('express');
const cors     = require('cors');
const session  = require('express-session');
const helmet   = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt   = require('bcryptjs');
const path     = require('path');
const { v4: uuidv4 } = require('uuid');

const database = require('./database');
const agent    = require('./agent');

const app  = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// =================== 管理员账号 ===================
// 密码在第一次启动时自动 bcrypt hash；支持环境变量覆盖
// 生产部署示例：ADMIN_USER=ops ADMIN_PASS_HASH=$2b$12$... node src/server.js
const ADMIN_RAW_PASS = process.env.ADMIN_PASS || 'admin888';
const ADMIN_PASS_HASH = process.env.ADMIN_PASS_HASH || bcrypt.hashSync(ADMIN_RAW_PASS, 12);

const ADMIN_ACCOUNTS = [
  {
    username: process.env.ADMIN_USER || 'admin',
    passwordHash: ADMIN_PASS_HASH,
    name: '超级管理员'
  }
];

// 首次启动打印哈希，方便生产环境固化
if (!IS_PROD) {
  console.log(`[AUTH] 当前密码 hash（生产环境请设置 ADMIN_PASS_HASH）:\n  ${ADMIN_PASS_HASH}\n`);
}

// =================== 安全 HTTP Headers（helmet）===================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],   // 内联脚本（无打包工具，必须允许）
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      baseUri:    ["'self'"]
    }
  },
  hsts: IS_PROD ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  frameguard:   { action: 'deny' },
  noSniff:      true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

// =================== CORS（白名单，不用 * ）===================
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || `http://localhost:${PORT}`)
  .split(',')
  .map(s => s.trim());

app.use(cors({
  origin: (origin, cb) => {
    // 允许无 origin（如 curl 测试、SSR）和白名单
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin "${origin}" not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'X-Requested-With']
}));

// =================== 请求体解析 + 大小限制 ===================
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: true, limit: '50kb' }));

// =================== Session（安全加固）===================
const SESSION_SECRET = process.env.SESSION_SECRET;
if (IS_PROD && !SESSION_SECRET) {
  throw new Error('[SERVER] 生产环境必须设置 SESSION_SECRET 环境变量！');
}

app.use(session({
  secret: SESSION_SECRET || 'cs-agent-dev-secret-' + Date.now(),
  resave: false,
  saveUninitialized: false,
  name: 'csid',   // 隐藏默认 connect.sid 名称
  cookie: {
    maxAge:   8 * 60 * 60 * 1000,
    httpOnly: true,
    secure:   IS_PROD,
    sameSite: 'strict'
  }
}));

// 静态文件
app.use(express.static(path.join(__dirname, '../public')));

// 初始化数据库
database.initFAQ();

// =================== 限流配置 ===================

/** 登录接口：10 次 / 15 分钟（防暴力破解） */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: '登录尝试次数过多，请 15 分钟后再试' },
  skipSuccessfulRequests: true   // 成功登录不计入
});

/** 聊天接口：60 条 / 分钟（防洪水）*/
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: '请求过于频繁，请稍后再试' }
});

// =================== 输入校验工具 ===================

/**
 * 验证字段存在且为字符串，限制最大长度
 */
function validateField(value, maxLen = 2000) {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'string') return false;
  if (value.trim().length === 0) return false;
  if (value.length > maxLen) return false;
  return true;
}

/**
 * 统一错误响应（不暴露栈信息）
 */
function errRes(res, status, message) {
  return res.status(status).json({ success: false, error: message });
}

// =================== 鉴权中间件 ===================

function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({
      success: false, error: '未登录，请先登录管理后台', redirect: '/login'
    });
  }
  res.redirect('/login?from=' + encodeURIComponent(req.originalUrl));
}

// =================== 登录 / 登出 API ===================

app.get('/login', (req, res) => {
  if (req.session && req.session.admin) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

/** POST /api/auth/login  —  限流 + bcrypt 验证 */
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};

  if (!validateField(username, 64) || !validateField(password, 128)) {
    return errRes(res, 400, '请输入用户名和密码');
  }

  // 防时序攻击：始终执行 bcrypt.compare（即使用户名不匹配）
  const account = ADMIN_ACCOUNTS.find(a => a.username === username) || ADMIN_ACCOUNTS[0];
  const match   = await bcrypt.compare(password, account.passwordHash);
  const isValid = match && account.username === username;

  if (!isValid) {
    console.warn(`[AUTH] 登录失败 - 用户名: ${username} - IP: ${req.ip}`);
    // 统一错误，不区分"用户名不存在"和"密码错误"
    return errRes(res, 401, '用户名或密码错误');
  }

  // 防 session fixation：登录时重新生成 session id
  req.session.regenerate(err => {
    if (err) return errRes(res, 500, '登录失败，请重试');
    req.session.admin = {
      username: account.username,
      name:     account.name,
      loginAt:  new Date().toISOString()
    };
    console.log(`[AUTH] 管理员登录 - ${account.name}(${account.username}) - IP: ${req.ip}`);
    res.json({ success: true, name: account.name });
  });
});

app.post('/api/auth/logout', (req, res) => {
  const name = req.session.admin?.name || '未知';
  req.session.destroy(() => {
    res.clearCookie('csid');
    console.log(`[AUTH] 管理员登出 - ${name}`);
    res.json({ success: true });
  });
});

app.get('/api/auth/me', (req, res) => {
  if (req.session && req.session.admin) {
    return res.json({ success: true, admin: req.session.admin });
  }
  res.status(401).json({ success: false, error: '未登录' });
});

// =================== 聊天 API（公开，限流）===================

app.post('/api/chat/start', chatLimiter, (req, res) => {
  try {
    const sessionId = uuidv4();
    const userId    = validateField(req.body?.userId, 64)
      ? req.body.userId.trim()
      : 'anonymous_' + sessionId.slice(-6);
    const userAgent = (req.headers['user-agent'] || '').slice(0, 200); // 截断

    const conv = database.createConversation(sessionId, userId, userAgent);
    const welcomeMsg = '您好！我是智能客服助手小智 🤖，很高兴为您服务！\n\n我可以帮您处理：\n• 💰 **退款** - 申请退款、查询退款状态\n• 📦 **订单** - 查询订单、物流跟踪\n• 🔧 **技术支持** - 登录问题、支付问题\n• 📋 **其他** - 发票、地址修改等\n\n请直接描述您遇到的问题，我来帮您解决！';

    database.addMessage(sessionId, 'bot', welcomeMsg, { type: 'welcome' });
    res.json({ success: true, sessionId, message: welcomeMsg });
  } catch (err) {
    console.error('[CHAT] 开始会话错误:', err.message);
    errRes(res, 500, '创建会话失败，请稍后重试');
  }
});

app.post('/api/chat/message', chatLimiter, async (req, res) => {
  try {
    const { sessionId, message } = req.body || {};

    if (!validateField(sessionId, 36)) {
      return errRes(res, 400, '参数不完整');
    }
    if (!validateField(message, 1000)) {
      return errRes(res, 400, message && message.length > 1000
        ? '消息过长，请控制在 1000 字以内'
        : '请输入消息内容');
    }

    const conv = database.getConversation(sessionId);
    if (!conv) return errRes(res, 404, '会话不存在，请重新开始');

    const result = await agent.processMessage(sessionId, message.trim());
    res.json({ success: true, ...result, sessionId });
  } catch (err) {
    console.error('[CHAT] 处理消息错误:', err.message);
    errRes(res, 500, '处理消息时发生错误，请稍后重试');
  }
});

app.post('/api/chat/rate', chatLimiter, (req, res) => {
  try {
    const { sessionId, rating } = req.body || {};
    const ratingNum = parseInt(rating);

    if (!validateField(sessionId, 36) || !ratingNum || ratingNum < 1 || ratingNum > 5) {
      return errRes(res, 400, '参数不正确');
    }

    const conv = database.getConversation(sessionId);
    if (!conv) return errRes(res, 404, '会话不存在');

    const response = agent.handleRating(sessionId, ratingNum);
    res.json({ success: true, message: response });
  } catch (err) {
    console.error('[CHAT] 评分错误:', err.message);
    errRes(res, 500, '提交评分失败');
  }
});

/** 历史记录需要管理员鉴权（防止对话内容被公开访问）*/
app.get('/api/chat/history/:sessionId', requireAdmin, (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    if (!validateField(sessionId, 36)) return errRes(res, 400, '参数错误');

    const conv = database.getConversation(sessionId);
    if (!conv) return errRes(res, 404, '会话不存在');

    res.json({ success: true, conversation: conv });
  } catch (err) {
    console.error('[CHAT] 历史查询错误:', err.message);
    errRes(res, 500, '查询失败');
  }
});

app.post('/api/chat/end', chatLimiter, (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!validateField(sessionId, 36)) return errRes(res, 400, '参数错误');

    const conv = database.getConversation(sessionId);
    if (conv && conv.status === 'active') {
      database.updateConversation(sessionId, {
        status:  'resolved',
        endTime: new Date().toISOString()
      });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[CHAT] 结束会话错误:', err.message);
    errRes(res, 500, '操作失败');
  }
});

// =================== 管理后台 API（需鉴权）===================

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  try {
    res.json({ success: true, stats: database.getStats() });
  } catch (err) {
    console.error('[ADMIN] stats 错误:', err.message);
    errRes(res, 500, '获取统计失败');
  }
});

app.get('/api/admin/conversations', requireAdmin, (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const status = req.query.status;
    const date   = req.query.date;
    const intent = req.query.intent;

    // 白名单过滤，防止任意字段枚举
    const validStatuses = ['active', 'human', 'resolved', 'abandoned'];
    const validIntents  = ['refund', 'order', 'technical', 'complaint', 'other'];
    const filters = {
      status: validStatuses.includes(status) ? status : undefined,
      date:   date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
      intent: validIntents.includes(intent) ? intent : undefined
    };

    const result = database.listConversations(page, limit, filters);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[ADMIN] conversations 错误:', err.message);
    errRes(res, 500, '查询失败');
  }
});

app.get('/api/admin/conversations/:id', requireAdmin, (req, res) => {
  try {
    const id = req.params.id;
    if (!validateField(id, 36)) return errRes(res, 400, '参数错误');

    const conv = database.getConversation(id);
    if (!conv) return errRes(res, 404, '对话不存在');
    res.json({ success: true, conversation: conv });
  } catch (err) {
    console.error('[ADMIN] conversation 详情错误:', err.message);
    errRes(res, 500, '查询失败');
  }
});

app.get('/api/admin/agents', requireAdmin, (req, res) => {
  try {
    res.json({ success: true, agents: database.db.agents });
  } catch (err) {
    errRes(res, 500, '查询失败');
  }
});

app.get('/api/admin/faq', requireAdmin, (req, res) => {
  try {
    res.json({ success: true, faqs: database.getFAQs() });
  } catch (err) {
    errRes(res, 500, '查询失败');
  }
});

// =================== 页面路由 ===================

app.get('/',      (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, '../public/admin.html')));

// =================== 全局错误处理（防栈追踪泄露）===================
app.use((err, req, res, next) => {
  // CORS 错误
  if (err.message && err.message.startsWith('CORS:')) {
    return res.status(403).json({ success: false, error: 'CORS 访问被拒绝' });
  }
  console.error('[SERVER] 未处理异常:', err.message);
  res.status(500).json({ success: false, error: '服务器内部错误' });
});

// =================== 启动 ===================
app.listen(PORT, () => {
  console.log(`\n🚀 智能客服 Agent 服务已启动 [${IS_PROD ? 'PRODUCTION' : 'DEVELOPMENT'}]`);
  console.log(`📱 客服聊天界面: http://localhost:${PORT}`);
  console.log(`🔧 管理后台:     http://localhost:${PORT}/admin`);
  console.log(`🔐 管理员登录:   http://localhost:${PORT}/login`);
  console.log(`👤 默认账号:     admin / admin888\n`);
});

module.exports = app;
