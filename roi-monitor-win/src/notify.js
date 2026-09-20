import fs from 'node:fs';
import path from 'node:path';
import { ROOT, info, warn } from './util.js';

/**
 * 主动推送。
 * level: 'info'(普通,走 channels) | 'alert'(红色预警/系统故障,走 alertChannels,含手机)
 * 频道:log / file / wecom(企业微信群机器人) / wecomApp(企业微信自建应用) / feishu / telegram
 */
export async function notify(config, { level = 'info', title, body, exclude = [] }) {
  const n = config.notify || {};
  const all = level === 'alert' ? n.alertChannels || n.channels || ['log'] : n.channels || ['log'];
  // exclude:这条消息已经用别的形式(比如飞书卡片)推过了,避免同一件事推两遍
  const channels = all.filter((c) => !exclude.includes(c));
  const text = `${title}\n${body}`;

  if (channels.includes('log')) {
    (level === 'alert' ? console.error : console.log)(
      `[通知][${level}] ${title} :: ${body.replace(/\n/g, ' | ')}`
    );
    info(`[通知已发][${level}] ${title}`);
  }
  if (channels.includes('file')) {
    try {
      const dir = path.join(ROOT, 'output');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, level === 'alert' ? 'ALERTS.log' : 'notifications.log');
      fs.appendFileSync(f, `[${new Date().toISOString()}] ${text}\n\n`);
    } catch (e) {
      warn('写通知文件失败:', e.message);
    }
  }
  if (channels.includes('wecom') && n.wecomWebhook && !/\$\{/.test(n.wecomWebhook)) {
    await sendWecomWebhook(n.wecomWebhook, text).catch((e) => warn('企业微信(机器人)推送失败:', e.message));
  }
  if (channels.includes('wecomApp') && n.wecomApp && n.wecomApp.corpid && !/\$\{/.test(n.wecomApp.corpid)) {
    await sendWecomApp(n.wecomApp, text).catch((e) => warn('企业微信(应用)推送失败:', e.message));
  }
  if (channels.includes('serverchan') && n.serverchanKey && !/\$\{/.test(n.serverchanKey)) {
    await sendServerChan(n.serverchanKey, title, body).catch((e) => warn('Server酱推送失败:', e.message));
  }
  if (channels.includes('feishuApp')) {
    // 自建应用「My Claude」→ 指定群。config.feishu 里配 appId/appSecret/chatId
    const { feishuEnabled, sendToChat } = await import('./feishu.js');
    if (feishuEnabled(config)) {
      await sendToChat(config, text).catch((e) => warn('飞书(应用)推送失败:', e.message));
    }
  }
  if (channels.includes('feishu') && n.feishuWebhook && !/\$\{/.test(n.feishuWebhook)) {
    await sendFeishu(n.feishuWebhook, text).catch((e) => warn('飞书推送失败:', e.message));
  }
  if (channels.includes('telegram') && n.telegram?.botToken && !/\$\{/.test(n.telegram.botToken)) {
    await sendTelegram(n.telegram, text).catch((e) => warn('Telegram 推送失败:', e.message));
  }
}

// ---- 企业微信 群机器人(webhook)----
async function sendWecomWebhook(webhook, text) {
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content: text.slice(0, 2000) } }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || (j.errcode && j.errcode !== 0)) throw new Error(`wecom webhook ${res.status} ${j.errmsg || ''}`);
}

// ---- 企业微信 自建应用(corpid + secret + agentid)----
async function sendWecomApp({ corpid, corpsecret, agentid, touser }, text) {
  const tokRes = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpid)}&corpsecret=${encodeURIComponent(corpsecret)}`
  );
  const tok = await tokRes.json();
  if (!tok.access_token) throw new Error(`gettoken 失败:${tok.errmsg || JSON.stringify(tok)}`);
  const res = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${tok.access_token}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: touser || '@all',
        msgtype: 'text',
        agentid: Number(agentid),
        text: { content: text.slice(0, 2000) },
      }),
    }
  );
  const j = await res.json();
  if (j.errcode && j.errcode !== 0) throw new Error(`message/send 失败:${j.errmsg}`);
}

// ---- Server酱 → 个人微信 ----
async function sendServerChan(key, title, body) {
  // Turbo 版 key 以 SCT 开头,走 sctapi;老版走 sc.ftqq.com
  const base = key.startsWith('SCT')
    ? `https://sctapi.ftqq.com/${key}.send`
    : `https://sc.ftqq.com/${key}.send`;
  const res = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ title: title.slice(0, 32), desp: body.slice(0, 3000) }).toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (j.code !== undefined && j.code !== 0) throw new Error(`serverchan ${j.code} ${j.message || ''}`);
  if (!res.ok) throw new Error(`serverchan http ${res.status}`);
}

// ---- 飞书自定义机器人 ----
async function sendFeishu(webhook, text) {
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg_type: 'text', content: { text } }),
  });
  if (!res.ok) throw new Error(`feishu ${res.status}`);
}

// ---- Telegram ----
async function sendTelegram({ botToken, chatId }, text) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) throw new Error(`telegram ${res.status}`);
}
