/**
 * Express 服务器主入口
 * 智能客服 Agent Web 应用
 */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const database = require('./database');
const agent = require('./agent');

const app = express();
const PORT = process.env.PORT || 3000;

// =================== 中间件 ===================
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// 初始化数据库
database.initFAQ();

// =================== 聊天 API ===================

/**
 * POST /api/chat/start - 开始新会话
 */
app.post('/api/chat/start', (req, res) => {
  try {
    const sessionId = uuidv4();
    const { userId } = req.body;
    const userAgent = req.headers['user-agent'] || '';

    const conv = database.createConversation(sessionId, userId, userAgent);

    // 发送欢迎消息
    const welcomeMsg = '您好！我是智能客服助手小智 🤖，很高兴为您服务！\n\n我可以帮您处理：\n• 💰 **退款** - 申请退款、查询退款状态\n• 📦 **订单** - 查询订单、物流跟踪\n• 🔧 **技术支持** - 登录问题、支付问题\n• 📋 **其他** - 发票、地址修改等\n\n请直接描述您遇到的问题，我来帮您解决！';

    database.addMessage(sessionId, 'bot', welcomeMsg, { type: 'welcome' });

    res.json({
      success: true,
      sessionId,
      message: welcomeMsg,
      conversation: conv
    });
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

    // 处理消息
    const result = await agent.processMessage(sessionId, message);

    res.json({
      success: true,
      ...result,
      sessionId
    });
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

// =================== 管理后台 API ===================

/**
 * GET /api/admin/stats - 获取统计数据
 */
app.get('/api/admin/stats', (req, res) => {
  try {
    const stats = database.getStats();
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/admin/conversations - 获取对话列表
 */
app.get('/api/admin/conversations', (req, res) => {
  try {
    const { page = 1, limit = 20, status, date, intent } = req.query;
    const result = database.listConversations(
      parseInt(page),
      parseInt(limit),
      { status, date, intent }
    );
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/admin/conversations/:id - 获取对话详情
 */
app.get('/api/admin/conversations/:id', (req, res) => {
  try {
    const conv = database.getConversation(req.params.id);
    if (!conv) {
      return res.status(404).json({ success: false, error: '对话不存在' });
    }
    res.json({ success: true, conversation: conv });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/admin/agents - 获取客服列表
 */
app.get('/api/admin/agents', (req, res) => {
  try {
    const agents = database.db.agents;
    res.json({ success: true, agents });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/admin/faq - 获取 FAQ 列表
 */
app.get('/api/admin/faq', (req, res) => {
  try {
    const faqs = database.getFAQs();
    res.json({ success: true, faqs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =================== 页面路由 ===================

// 聊天页面
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// 管理后台
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

// =================== 启动服务器 ===================
app.listen(PORT, () => {
  console.log(`\n🚀 智能客服 Agent 服务已启动！`);
  console.log(`📱 客服聊天界面: http://localhost:${PORT}`);
  console.log(`🔧 管理后台: http://localhost:${PORT}/admin`);
  console.log(`📊 API文档: http://localhost:${PORT}/api/admin/stats\n`);
});

module.exports = app;
