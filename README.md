# 智能客服 Agent Web 应用

基于 Node.js + Express 构建的全功能智能客服系统，支持多轮对话、FAQ 知识库检索、意图识别、自动转人工、满意度评分，以及完整的管理后台。

## 功能特性

| 功能 | 说明 |
|------|------|
| 🤖 多轮对话 | 带上下文记忆，意图跨轮次延续 |
| 🔍 FAQ 知识库 | 8 条初始 FAQ，关键词权重评分匹配 |
| 🎯 意图识别 | 退款 / 查询订单 / 技术支持 / 投诉 / 其他 |
| 👨‍💼 自动转人工 | 用户主动请求 / 连续未解决 / 投诉自动触发 |
| 📁 对话持久化 | JSON 文件存储，重启不丢失 |
| ⭐ 满意度评分 | 1-5 星 emoji 交互卡片 |
| 📊 管理后台 | 数据统计、趋势图、意图分布、对话记录查询 |

## 项目结构

```
smart-customer-service/
├── src/
│   ├── server.js      # Express 服务器 + REST API
│   ├── agent.js       # 智能 Agent 核心逻辑（意图识别、FAQ检索）
│   └── database.js    # 数据持久化（JSON 文件，无需编译）
├── public/
│   ├── index.html     # 客服聊天界面
│   └── admin.html     # 管理后台（Chart.js 图表）
├── data/              # 运行时生成，存放 database.json
├── package.json
└── .gitignore
```

## 快速启动

```bash
# 安装依赖
npm install

# 启动服务
node src/server.js
```

访问地址：
- 💬 客服聊天界面：http://localhost:3000
- ⚙️ 管理后台：http://localhost:3000/admin

## 技术栈

- **后端**：Node.js + Express
- **前端**：原生 HTML/CSS/JS（无框架依赖）
- **图表**：Chart.js（CDN）
- **存储**：JSON 文件持久化（无需数据库）
- **依赖**：express、cors、body-parser、uuid

## API 文档

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/chat/start` | 开始新会话 |
| POST | `/api/chat/message` | 发送消息 |
| POST | `/api/chat/rate` | 提交评分 |
| GET | `/api/chat/history/:id` | 获取对话历史 |
| GET | `/api/admin/stats` | 获取统计数据 |
| GET | `/api/admin/conversations` | 获取对话列表 |
| GET | `/api/admin/conversations/:id` | 获取对话详情 |
| GET | `/api/admin/agents` | 获取客服列表 |
| GET | `/api/admin/faq` | 获取 FAQ 列表 |
