/**
 * Express 服务器主入口
 * 智能客服 Agent Web 应用
 */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const database = require('./database');
const agent = require('./agent');

const app = express();
const PORT = process.env.PORT || 3000;

// =================== 管理员账号配置 ===================
// 可通过环境变量覆盖，默认账号 admin / admin888
const ADMIN_ACCOUNTS = [
  {
    username: process.env.ADMIN_USER || 'admin',
    password: process.env.ADMIN_PASS || 'admin888',
    name: '超级管理员'
  }
];

// =================== 中间件 ===================
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Session 配置
app.use(session({
  secret: process.env.SESSION_SECRET || 'cs-agent-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 8 * 60 * 60 * 1000,  // 8小时
    httpOnly: true
  }
}));

// 静态文件（公开）
app.use(express.static(path.join(__dirname, '../public')));

// 初始化数据库
database.initFAQ();

// =================== 鉴权中间件 ===================

/**
 * 验证管理员 session
 */
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) {
    return next();
  }
  // API 请求返回 401 JSON
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ success: false, error: '未登录，请先登录管理后台', redirect: '/login' });
  }
  // 页面请求重定向到登录页
  res.redirect('/login?from=' + encodeURIComponent(req.originalUrl));
}

// =================== 登录/登出 API ===================

/**
 * GET /login - 登录页面
 */
app.get('/login', (req, res) => {
  if (req.session && req.session.admin) {
    return res.redirect('/admin');
  }
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

/**
 * POST /api/auth/login - 登录接口
 */
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, error: '请输入用户名和密码' });
  }

  const account = ADMIN_ACCOUNTS.find(
    a => a.username === username && a.password === password
  );

  if (!account) {
    // 记录失败（防暴力破解可在此加频率限制）
    console.warn(`[AUTH] 登录失败 - 用户名: ${username} - IP: ${req.ip}`);
    return res.status(401).json({ success: false, error: '用户名或密码错误' });
  }

  // 登录成功，写入 session
  req.session.admin = {
    username: account.username,
    name: account.name,
    loginAt: new Date().toISOString()
  };

  console.log(`[AUTH] 管理员登录 - ${account.name}(${account.username}) - IP: ${req.ip}`);
  res.json({ success: true, name: account.name });
});

/**
 * POST /api/auth/logout - 登出接口
 */
app.post('/api/auth/logout', (req, res) => {
  const name = req.session.admin?.name || '未知';
  req.session.destroy(() => {
    console.log(`[AUTH] 管理员登出 - ${name}`);
    res.json({ success: true });
  });
});

/**
 * GET /api/auth/me - 获取当前登录状态
 */
app.get('/api/auth/me', (req, res) => {
  if (req.session && req.session.admin) {
    res.json({ success: true, admin: req.session.admin });
  } else {
    res.status(401).json({ success: false, error: '未登录' });
  }
});

// =================== 聊天 API（公开）===================

/**
 * POST /api/chat/start - 开始新会话
 */
app.post('/api/chat/start', (req, res) => {
  try {
    const sessionId = uuidv4();
    const { userId } = req.body;
    const userAgent = req.headers['user-agent'] || '';

    const conv = database.createConversation(sessionId, userId, userAgent);

    const welcomeMsg = '您好！我是智能客服助手小智 🤖，很高兴为您服务！\n\n我可以帮您处理：\n• 💰 **退款** - 申请退款、查询退款状态\n• 📦 **订单** - 查询订单、物流跟踪\n• 🔧 **技术支持** - 登录问题、支付问题\n• 📋 **其他** - 发票、地址修改等\n\n请直接描述您遇到的问题，我来帮您解决！';

    database.addMessage(sessionId, 'bot', welcomeMsg, { type: 'welcome' });

    res.json({ success: true, sessionId, message: welcomeMsg, conversation: conv });
  } catch (err) {
    console.error('开始会话错误:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/chat/message - 发送消息
 */
app.post('/api/chat/message', async (req, res) => {
  try {
    const { sessionId, message } = req.body;

    if (!sessionId || !message) {
      return res.status(400).json({ success: false, error: '参数不完整' });
    }

    const conv = database.getConversation(sessionId);
    if (!conv) {
      return res.status(404).json({ success: false, error: '会话不存在，请重新开始' });
    }

    const result = await agent.processMessage(sessionId, message);
    res.json({ success: true, ...result, sessionId });
  } catch (err) {
    console.error('处理消息错误:', err);
    res.status(500).json({ success: false, error: '处理消息时发生错误，请稍后重试' });
  }
});

/**
 * POST /api/chat/rate - 用户评分
 */
app.post('/api/chat/rate', (req, res) => {
  try {
    const { sessionId, rating } = req.body;

    if (!sessionId || !rating || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, error: '参数不正确' });
    }

    const response = agent.handleRating(sessionId, parseInt(rating));
    res.json({ success: true, message: response });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/chat/history/:sessionId - 获取对话历史
 */
app.get('/api/chat/history/:sessionId', (req, res) => {
  try {
    const conv = database.getConversation(req.params.sessionId);
    if (!conv) {
      return res.status(404).json({ success: false, error: '会话不存在' });
    }
    res.json({ success: true, conversation: conv });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/chat/end - 结束会话
 */
app.post('/api/chat/end', (req, res) => {
  try {
    const { sessionId } = req.body;
    const conv = database.getConversation(sessionId);
    if (conv && conv.status === 'active') {
      database.updateConversation(sessionId, {
        status: 'resolved',
        endTime: new Date().toISOString()
      });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =================== 管理后台 API（需鉴权）===================

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  try {
    res.json({ success: true, stats: database.getStats() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/conversations', requireAdmin, (req, res) => {
  try {
    const { page = 1, limit = 20, status, date, intent } = req.query;
    const result = database.listConversations(parseInt(page), parseInt(limit), { status, date, intent });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/conversations/:id', requireAdmin, (req, res) => {
  try {
    const conv = database.getConversation(req.params.id);
    if (!conv) return res.status(404).json({ success: false, error: '对话不存在' });
    res.json({ success: true, conversation: conv });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/agents', requireAdmin, (req, res) => {
  try {
    res.json({ success: true, agents: database.db.agents });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/faq', requireAdmin, (req, res) => {
  try {
    res.json({ success: true, faqs: database.getFAQs() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =================== 页面路由 ===================

// 客服聊天（公开）
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// 管理后台（需鉴权）
app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

// =================== 启动服务器 ===================
app.listen(PORT, () => {
  console.log(`\n🚀 智能客服 Agent 服务已启动！`);
  console.log(`📱 客服聊天界面: http://localhost:${PORT}`);
  console.log(`🔧 管理后台:     http://localhost:${PORT}/admin`);
  console.log(`🔐 管理员登录:   http://localhost:${PORT}/login`);
  console.log(`👤 默认账号:     admin / admin888\n`);
});

module.exports = app;
