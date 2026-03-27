/**
 * 智能客服 Agent 核心逻辑
 * - 意图识别（退款/查询订单/技术支持/其他）
 * - FAQ 知识库检索（关键词匹配 + TF-IDF 评分）
 * - 多轮对话上下文管理
 * - 自动转人工判断
 */

const db = require('./database');

// =================== 意图识别 ===================

const INTENT_PATTERNS = {
  refund: {
    keywords: ['退款', '退钱', '退货', '退费', '钱没到', '申请退', '要求退', '退了吗', '退回'],
    patterns: [/退[款钱货费]/, /申请退/, /钱.{0,5}退/],
    weight: 1.2
  },
  order: {
    keywords: ['订单', '查订单', '订单状态', '发货', '物流', '快递', '配送', '发了吗', '什么时候发', '到了吗', '在哪'],
    patterns: [/订单[号码]?/, /查[一下看看]?(订单|物流|快递)/, /发货/, /物流/],
    weight: 1.0
  },
  technical: {
    keywords: ['登录', '密码', '无法', '登不上', '打不开', '报错', '错误', '故障', '崩溃', '支付失败', '付款', '页面', 'bug', '问题'],
    patterns: [/登[录陆]/, /密码/, /无法.{0,5}(登|支付|访问)/, /支付失败/, /报错/],
    weight: 1.1
  },
  complaint: {
    keywords: ['投诉', '举报', '态度差', '不满意', '太差', '垃圾', '骗人', '欺诈'],
    patterns: [/投诉/, /不满意/, /态度/],
    weight: 1.3
  },
  other: {
    keywords: ['发票', '开票', '修改', '地址', '优惠', '活动', '积分', '会员'],
    patterns: [],
    weight: 0.9
  }
};

/**
 * 识别用户意图
 * @param {string} text - 用户输入文本
 * @param {Array} history - 对话历史
 * @returns {{ intent: string, confidence: number, matched: string[] }}
 */
function recognizeIntent(text, history = []) {
  const normalText = text.toLowerCase();
  const scores = {};
  const matchedKeywords = {};

  for (const [intent, config] of Object.entries(INTENT_PATTERNS)) {
    let score = 0;
    matchedKeywords[intent] = [];

    // 关键词匹配
    for (const kw of config.keywords) {
      if (normalText.includes(kw)) {
        score += 1 * config.weight;
        matchedKeywords[intent].push(kw);
      }
    }

    // 正则模式匹配（更高权重）
    for (const pattern of config.patterns) {
      if (pattern.test(normalText)) {
        score += 2 * config.weight;
      }
    }

    scores[intent] = score;
  }

  // 考虑历史上下文
  if (history.length > 0) {
    const lastIntent = history[history.length - 1]?.detectedIntent;
    if (lastIntent && scores[lastIntent] > 0) {
      scores[lastIntent] *= 1.3; // 上下文加权
    }
  }

  // 找最高分
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topIntent, topScore] = sorted[0];

  if (topScore === 0) {
    return { intent: 'unknown', confidence: 0, matched: [] };
  }

  const confidence = Math.min(topScore / 5, 1); // 归一化到 0-1
  return {
    intent: topIntent,
    confidence,
    matched: matchedKeywords[topIntent] || []
  };
}

// =================== FAQ 检索 ===================

/**
 * 计算文本相似度（基于关键词重叠）
 */
function calculateSimilarity(text, faqItem) {
  const textLower = text.toLowerCase();
  let score = 0;

  // 主关键词匹配
  for (const kw of faqItem.keywords) {
    if (textLower.includes(kw)) {
      score += 3;
    }
  }

  // 相关关键词匹配
  for (const kw of (faqItem.relatedKeywords || [])) {
    if (textLower.includes(kw)) {
      score += 1;
    }
  }

  // 问题文本相似度
  const questionWords = faqItem.question.split(/[，。？\s]+/);
  for (const word of questionWords) {
    if (word.length > 1 && textLower.includes(word)) {
      score += 0.5;
    }
  }

  return score;
}

/**
 * 检索 FAQ 知识库
 * @param {string} text - 用户问题
 * @param {string} intent - 已识别的意图
 * @returns {Array} 匹配的 FAQ 列表（按相关度排序）
 */
function searchFAQ(text, intent = null) {
  const faqs = db.getFAQs();
  const results = [];

  for (const faq of faqs) {
    let score = calculateSimilarity(text, faq);

    // 意图匹配加权
    if (intent && faq.intent === intent) {
      score *= 1.5;
    }

    if (score > 0) {
      results.push({ ...faq, score });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 3);
}

// =================== 多轮对话管理 ===================

// 内存中的会话状态（短期）
const sessionStates = new Map();

function getSessionState(sessionId) {
  if (!sessionStates.has(sessionId)) {
    sessionStates.set(sessionId, {
      turn: 0,
      lastIntent: null,
      failedAttempts: 0,    // 连续未解决次数
      pendingInfo: null,    // 待收集的信息（如订单号）
      context: {}           // 上下文信息
    });
  }
  return sessionStates.get(sessionId);
}

function updateSessionState(sessionId, updates) {
  const state = getSessionState(sessionId);
  Object.assign(state, updates);
}

// =================== 响应生成 ===================

const GREETINGS = [
  '您好！我是智能客服助手小智 🤖，很高兴为您服务！\n\n我可以帮您处理以下问题：\n• 💰 退款申请与查询\n• 📦 订单状态查询\n• 🔧 技术问题解决\n• 📄 其他常见问题\n\n请问您有什么需要帮助的？',
  '您好！欢迎使用智能客服 🤖\n\n我能为您提供：退款处理、订单查询、技术支持等服务。\n请直接描述您的问题，我来帮您解决！'
];

const TRANSFER_MESSAGES = {
  refund: '您的退款问题可能需要核实具体信息，我为您转接专业退款处理客服...',
  order: '需要查询您的具体订单信息，我为您转接订单专员...',
  technical: '您遇到的技术问题需要专业人员协助，正在为您转接技术支持团队...',
  complaint: '非常抱歉给您带来不便，正在为您转接高级客服专员...',
  default: '您的问题需要人工客服进一步协助，正在为您转接...'
};

/**
 * 检测是否需要转人工
 */
function shouldTransferToHuman(state, intentResult, userText) {
  // 明确要求转人工
  const transferKeywords = ['人工', '客服', '转人工', '真人', '换人', '找人', '不想和机器人', '要真人'];
  if (transferKeywords.some(kw => userText.includes(kw))) {
    return { transfer: true, reason: 'user_request' };
  }

  // 连续 3 次未能解决
  if (state.failedAttempts >= 3) {
    return { transfer: true, reason: 'failed_attempts' };
  }

  // 投诉类意图直接转人工
  if (intentResult.intent === 'complaint' && intentResult.confidence > 0.5) {
    return { transfer: true, reason: 'complaint' };
  }

  // 高紧急度关键词
  const urgentKeywords = ['紧急', '急急急', '马上', '立刻', '今天必须'];
  if (urgentKeywords.some(kw => userText.includes(kw))) {
    return { transfer: true, reason: 'urgent' };
  }

  return { transfer: false };
}

/**
 * 主处理函数 - 处理用户消息
 */
async function processMessage(sessionId, userMessage) {
  const conv = db.getConversation(sessionId);
  if (!conv) {
    throw new Error('会话不存在: ' + sessionId);
  }

  // 如果已转人工，不再由 bot 处理
  if (conv.status === 'human') {
    return {
      type: 'human',
      message: '您当前已接入人工客服，请稍等客服回复。',
      agent: db.db.agents.find(a => a.id === conv.agentId)
    };
  }

  const state = getSessionState(sessionId);
  state.turn++;

  // 保存用户消息
  db.addMessage(sessionId, 'user', userMessage);

  // 对话历史（用于上下文）
  const history = conv.messages.slice(-6).filter(m => m.role === 'user').map(m => ({
    text: m.content,
    detectedIntent: state.lastIntent
  }));

  // 意图识别
  const intentResult = recognizeIntent(userMessage, history);
  state.lastIntent = intentResult.intent;

  // 更新会话意图
  if (intentResult.intent !== 'unknown' && !conv.intent) {
    db.updateConversation(sessionId, { intent: intentResult.intent });
  }

  // 检查是否转人工
  const transferCheck = shouldTransferToHuman(state, intentResult, userMessage);
  if (transferCheck.transfer) {
    const agent = db.assignAgent(sessionId);
    const transferMsg = TRANSFER_MESSAGES[intentResult.intent] || TRANSFER_MESSAGES.default;

    let response;
    if (agent) {
      response = `${transferMsg}\n\n✅ 已为您成功转接至**${agent.name}**（${agent.specialty}）\n\n请稍候，客服将很快与您联系。等待期间您也可以继续描述问题。`;
    } else {
      response = `${transferMsg}\n\n⚠️ 当前人工客服较忙，已将您加入等候队列，预计等待时间 5-10 分钟。\n\n您也可以先告诉我更多详情，我会整理后转交给客服处理。`;
      db.updateConversation(sessionId, { status: 'human', agentId: null });
    }

    db.addMessage(sessionId, 'bot', response, {
      intent: intentResult.intent,
      action: 'transfer',
      agentId: agent?.id
    });

    return {
      type: 'transfer',
      message: response,
      agent,
      intent: intentResult.intent
    };
  }

  // FAQ 检索
  const faqResults = searchFAQ(userMessage, intentResult.intent);

  let botResponse;
  let resolved = false;

  if (faqResults.length > 0 && faqResults[0].score >= 2) {
    // 找到相关 FAQ
    const topFAQ = faqResults[0];
    botResponse = topFAQ.answer;

    // 如果有多个候选，添加相关问题
    if (faqResults.length > 1 && faqResults[1].score >= 1.5) {
      botResponse += '\n\n**您可能还想了解：**\n';
      faqResults.slice(1, 3).forEach((faq, idx) => {
        botResponse += `${idx + 1}. ${faq.question}\n`;
      });
    }

    // 追加满意度询问（每 3 轮或首次匹配后）
    if (state.turn >= 2 || faqResults[0].score >= 4) {
      botResponse += '\n\n---\n以上信息是否解决了您的问题？';
      resolved = true;
    }

    state.failedAttempts = 0; // 重置失败计数
  } else {
    // 未找到匹配 FAQ
    state.failedAttempts++;

    if (intentResult.intent === 'refund') {
      botResponse = '我理解您想申请退款。为了帮您处理，能告诉我：\n1. 您的订单号是？\n2. 退款原因（商品问题/不想要了/其他）？\n\n有了这些信息，我可以为您快速处理。';
    } else if (intentResult.intent === 'order') {
      botResponse = '我来帮您查询订单！请提供您的订单号（例如：ORD20240001），我立即为您查询。';
    } else if (intentResult.intent === 'technical') {
      botResponse = '我理解您遇到了技术问题。能详细描述一下：\n• 出现什么错误提示？\n• 是什么设备和浏览器？\n• 什么时候开始出现的？\n\n这些信息有助于我快速定位问题。';
    } else if (state.failedAttempts >= 2) {
      botResponse = '抱歉，我暂时无法准确理解您的问题 😅\n\n您可以：\n1. **换个方式描述**一下您的问题\n2. 或者直接告诉我您想咨询什么类别：退款/订单/技术问题/其他\n3. 如果需要，我可以**为您转接人工客服**';
    } else {
      botResponse = '您好，我是智能客服小智 🤖\n\n您的问题我已收到，请问您是遇到以下哪类问题？\n• 💰 退款问题\n• 📦 订单/物流问题\n• 🔧 技术/登录问题\n• 📋 其他问题（发票、地址修改等）\n\n或者直接描述您的具体问题，我来帮您解答！';
    }
  }

  // 保存 bot 回复
  db.addMessage(sessionId, 'bot', botResponse, {
    intent: intentResult.intent,
    confidence: intentResult.confidence,
    faqMatched: faqResults.length > 0 ? faqResults[0].id : null,
    resolved
  });

  // 如果已解决，更新状态
  if (resolved && state.failedAttempts === 0) {
    // 不立即关闭，等用户反馈
  }

  updateSessionState(sessionId, state);

  return {
    type: 'bot',
    message: botResponse,
    intent: intentResult.intent,
    confidence: intentResult.confidence,
    faqMatched: faqResults.length > 0,
    turn: state.turn
  };
}

/**
 * 处理用户评分
 */
function handleRating(sessionId, rating) {
  db.updateConversation(sessionId, {
    rating,
    status: 'resolved',
    endTime: new Date().toISOString()
  });

  const messages = {
    5: '太感谢您的认可了！⭐⭐⭐⭐⭐ 您的满意是我们最大的动力！',
    4: '感谢您的评价！⭐⭐⭐⭐ 我们会继续努力提供更好的服务！',
    3: '感谢反馈！⭐⭐⭐ 我们会持续改进，希望下次能给您更好的体验。',
    2: '感谢您的评价！⭐⭐ 非常抱歉没能很好地解决您的问题，我们会认真改进。',
    1: '非常抱歉让您失望了 😔 您的反馈对我们很重要，我们会立即整改。如有需要，可联系人工客服进一步处理。'
  };

  db.addMessage(sessionId, 'system', `用户评分：${rating}星`, { rating });

  return messages[rating] || '感谢您的评价！';
}

module.exports = {
  processMessage,
  recognizeIntent,
  searchFAQ,
  handleRating,
  getSessionState
};
