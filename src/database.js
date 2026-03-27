/**
 * 数据库模块 - 使用内存 + JSON 持久化存储
 * 轻量级实现，无需编译的 SQLite
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const DB_FILE = path.join(DATA_DIR, 'database.json');

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 初始化数据结构
function initDB() {
  const defaultData = {
    conversations: {},    // 对话记录 { sessionId: { id, userId, startTime, endTime, status, intent, messages, rating, agentId } }
    sessions: {},         // 会话状态 { sessionId: { ... } }
    faq: [],              // FAQ知识库
    agents: [],           // 人工客服列表
    stats: {              // 统计数据
      totalConversations: 0,
      resolvedByBot: 0,
      transferredToHuman: 0,
      ratings: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      intentStats: { refund: 0, order: 0, technical: 0, other: 0 },
      dailyStats: {}
    }
  };
  return defaultData;
}

// 加载数据
function loadData() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.warn('数据库加载失败，使用初始数据:', e.message);
  }
  return initDB();
}

// 保存数据
function saveData(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error('数据库保存失败:', e.message);
  }
}

// 全局数据
let db = loadData();

// 初始化 FAQ 知识库
function initFAQ() {
  if (db.faq.length === 0) {
    db.faq = [
      {
        id: 'faq_001',
        intent: 'refund',
        keywords: ['退款', '退钱', '退货', '钱没到', '退费'],
        question: '如何申请退款？',
        answer: '您好！退款申请流程如下：\n1. 登录账户，进入「订单中心」\n2. 找到需要退款的订单，点击「申请退款」\n3. 选择退款原因并提交\n4. 退款将在 3-5 个工作日内原路退回\n\n如有特殊情况，请告知订单号，我为您进一步处理。',
        relatedKeywords: ['退款周期', '退款状态', '退款方式']
      },
      {
        id: 'faq_002',
        intent: 'refund',
        keywords: ['退款多久', '退款时间', '退款到账', '什么时候退'],
        question: '退款需要多长时间？',
        answer: '退款到账时间：\n• 支付宝/微信支付：1-3 个工作日\n• 银行卡：3-7 个工作日\n• 信用卡：1-15 个工作日（视银行而定）\n\n节假日期间可能有所延迟，请您耐心等待。',
        relatedKeywords: ['退款方式', '退款状态']
      },
      {
        id: 'faq_003',
        intent: 'order',
        keywords: ['查订单', '订单状态', '我的订单', '订单号', '订单查询', '查询订单'],
        question: '如何查询订单状态？',
        answer: '查询订单状态的方式：\n1. **APP端**：首页 → 「我的」→「订单管理」\n2. **网页端**：登录后点击右上角头像 → 「我的订单」\n3. **客服查询**：提供订单号，我立即为您查询\n\n请问您的订单号是多少？',
        relatedKeywords: ['发货状态', '物流查询']
      },
      {
        id: 'faq_004',
        intent: 'order',
        keywords: ['发货', '物流', '快递', '配送', '到哪了', '在哪里'],
        question: '如何查询物流/快递信息？',
        answer: '查询物流信息：\n1. 订单详情页可查看实时物流\n2. 也可通过快递单号在官方快递网站查询\n\n一般下单后 24-48 小时内发货，节假日顺延。如订单已超时未发货，请告知订单号，我为您处理。',
        relatedKeywords: ['发货时间', '配送范围']
      },
      {
        id: 'faq_005',
        intent: 'technical',
        keywords: ['登录失败', '无法登录', '登录不了', '密码错误', '账号问题'],
        question: '登录遇到问题怎么办？',
        answer: '登录问题解决方案：\n1. **忘记密码**：点击「忘记密码」通过手机号/邮箱重置\n2. **账号被锁**：多次输错密码会暂时锁定，等待 30 分钟后重试\n3. **验证码收不到**：检查手机信号/邮件垃圾箱，或更换验证方式\n4. **清除缓存**：尝试清除浏览器缓存或重新安装 APP\n\n如以上方法无效，请告知具体错误提示。',
        relatedKeywords: ['密码重置', '账号安全']
      },
      {
        id: 'faq_006',
        intent: 'technical',
        keywords: ['支付失败', '无法支付', '扣款失败', '付款问题'],
        question: '支付失败怎么办？',
        answer: '支付失败常见原因及解决方案：\n1. **余额不足**：请确认账户/银行卡余额\n2. **网络问题**：检查网络连接后重试\n3. **银行卡限额**：联系发卡行提高限额\n4. **支付方式问题**：尝试更换其他支付方式\n5. **系统维护**：如系统提示维护中，稍后重试\n\n若重复失败，请告知错误提示截图，我为您处理。',
        relatedKeywords: ['支付方式', '退款']
      },
      {
        id: 'faq_007',
        intent: 'other',
        keywords: ['发票', '开票', '税票', '报销'],
        question: '如何申请发票？',
        answer: '申请发票流程：\n1. 进入「订单详情」→「申请发票」\n2. 选择发票类型（电子/纸质）\n3. 填写发票抬头和税号\n4. 提交后 1-3 个工作日内开具\n\n电子发票将发送至您的邮箱，纸质发票约 5-7 个工作日寄达。',
        relatedKeywords: ['发票抬头', '增值税发票']
      },
      {
        id: 'faq_008',
        intent: 'other',
        keywords: ['修改地址', '改地址', '收货地址', '换地址'],
        question: '如何修改收货地址？',
        answer: '修改收货地址：\n• **未发货订单**：可在订单详情页修改收货地址\n• **已发货订单**：需联系快递公司协商改派\n\n注意：修改地址可能影响预计送达时间。请问您的订单当前状态是什么？',
        relatedKeywords: ['退货地址', '换货']
      }
    ];
    saveData(db);
    console.log('✅ FAQ 知识库已初始化，共', db.faq.length, '条');
  }

  // 初始化人工客服
  if (db.agents.length === 0) {
    db.agents = [
      { id: 'agent_001', name: '小美', status: 'online', specialty: '退款处理', currentLoad: 0 },
      { id: 'agent_002', name: '小林', status: 'online', specialty: '订单查询', currentLoad: 0 },
      { id: 'agent_003', name: '小张', status: 'busy', specialty: '技术支持', currentLoad: 3 }
    ];
    saveData(db);
  }
}

// =================== CRUD 方法 ===================

// 创建会话
function createConversation(sessionId, userId, userAgent) {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  db.conversations[sessionId] = {
    id: sessionId,
    userId: userId || 'anonymous_' + sessionId.slice(-6),
    startTime: now,
    endTime: null,
    status: 'active',   // active | human | resolved | abandoned
    intent: null,
    messages: [],
    rating: null,
    agentId: null,
    userAgent: userAgent || '',
    date: today
  };

  // 统计
  db.stats.totalConversations++;
  if (!db.stats.dailyStats[today]) {
    db.stats.dailyStats[today] = { conversations: 0, resolved: 0, transferred: 0, ratings: [] };
  }
  db.stats.dailyStats[today].conversations++;

  saveData(db);
  return db.conversations[sessionId];
}

// 获取会话
function getConversation(sessionId) {
  return db.conversations[sessionId] || null;
}

// 添加消息
function addMessage(sessionId, role, content, metadata = {}) {
  const conv = db.conversations[sessionId];
  if (!conv) return null;

  const msg = {
    id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    role,        // user | bot | system | agent
    content,
    timestamp: new Date().toISOString(),
    ...metadata
  };

  conv.messages.push(msg);
  saveData(db);
  return msg;
}

// 更新会话状态
function updateConversation(sessionId, updates) {
  const conv = db.conversations[sessionId];
  if (!conv) return null;

  Object.assign(conv, updates);

  // 统计更新
  const today = conv.date;
  if (!db.stats.dailyStats[today]) {
    db.stats.dailyStats[today] = { conversations: 0, resolved: 0, transferred: 0, ratings: [] };
  }

  if (updates.status === 'resolved') {
    db.stats.resolvedByBot++;
    db.stats.dailyStats[today].resolved++;
  }
  if (updates.status === 'human') {
    db.stats.transferredToHuman++;
    db.stats.dailyStats[today].transferred++;
  }
  if (updates.rating) {
    db.stats.ratings[updates.rating] = (db.stats.ratings[updates.rating] || 0) + 1;
    db.stats.dailyStats[today].ratings.push(updates.rating);
  }
  if (updates.intent) {
    db.stats.intentStats[updates.intent] = (db.stats.intentStats[updates.intent] || 0) + 1;
  }

  saveData(db);
  return conv;
}

// 获取所有对话列表（分页）
function listConversations(page = 1, limit = 20, filters = {}) {
  let list = Object.values(db.conversations);

  // 过滤
  if (filters.status) list = list.filter(c => c.status === filters.status);
  if (filters.date) list = list.filter(c => c.date === filters.date);
  if (filters.intent) list = list.filter(c => c.intent === filters.intent);

  // 排序（最新在前）
  list.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

  const total = list.length;
  const start = (page - 1) * limit;
  const items = list.slice(start, start + limit).map(c => ({
    ...c,
    messageCount: c.messages.length
  }));

  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

// 获取统计数据
function getStats() {
  const stats = { ...db.stats };

  // 计算平均满意度
  let totalRating = 0, ratingCount = 0;
  for (const [score, count] of Object.entries(stats.ratings)) {
    totalRating += parseInt(score) * count;
    ratingCount += count;
  }
  stats.avgRating = ratingCount > 0 ? (totalRating / ratingCount).toFixed(1) : 0;
  stats.ratingCount = ratingCount;

  // 最近 7 天数据
  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const dayData = stats.dailyStats[dateStr] || { conversations: 0, resolved: 0, transferred: 0, ratings: [] };
    const avgR = dayData.ratings.length > 0
      ? (dayData.ratings.reduce((a, b) => a + b, 0) / dayData.ratings.length).toFixed(1)
      : 0;
    last7Days.push({ date: dateStr, ...dayData, avgRating: avgR });
  }
  stats.last7Days = last7Days;

  return stats;
}

// 获取 FAQ 列表
function getFAQs() {
  return db.faq;
}

// 获取在线客服
function getAvailableAgents() {
  return db.agents.filter(a => a.status === 'online');
}

// 分配客服
function assignAgent(sessionId) {
  const available = db.agents.filter(a => a.status === 'online');
  if (available.length === 0) return null;

  // 负载均衡：选择负载最低的
  available.sort((a, b) => a.currentLoad - b.currentLoad);
  const agent = available[0];
  agent.currentLoad++;

  updateConversation(sessionId, { status: 'human', agentId: agent.id });
  saveData(db);
  return agent;
}

// 释放客服
function releaseAgent(agentId) {
  const agent = db.agents.find(a => a.id === agentId);
  if (agent && agent.currentLoad > 0) {
    agent.currentLoad--;
    saveData(db);
  }
}

module.exports = {
  initFAQ,
  createConversation,
  getConversation,
  addMessage,
  updateConversation,
  listConversations,
  getStats,
  getFAQs,
  getAvailableAgents,
  assignAgent,
  releaseAgent,
  saveData,
  get db() { return db; }
};
