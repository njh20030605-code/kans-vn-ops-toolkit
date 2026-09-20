import { detectLoginState, hardDeadline } from './browser.js';

const VALID_STATES = ['logged_out', 'captcha', 'risk_control', 'loading', 'ready', 'unknown'];

/**
 * 判断当前页面状态。先用确定性规则,只有当规则给出 unknown 且 LLM 可用时才兜底。
 * 返回 { state, source }。
 */
export async function classifyPageState(page, llm) {
  const rule = await detectLoginState(page);
  let state = rule.state;

  if (state !== 'unknown' || !llm || !llm.available) {
    return { state, source: 'rule' };
  }

  // LLM 兜底:把页面文本片段交给它分类
  let text = '';
  try {
    text = await hardDeadline(
      page.evaluate(() => document.body?.innerText?.slice(0, 3000) || ''),
      15000,
      '读页面文本'
    );
  } catch {
    return { state: 'unknown', source: 'rule' };
  }
  const obj = await llm.askJson(
    '你是网页状态分类器。只输出 JSON:{"state": one of ["logged_out","captcha","risk_control","loading","ready","unknown"]}。不要解释。',
    `这是 TikTok 卖家后台某页面的可见文本片段,判断其状态:\n\n${text}`,
    (o) => o && typeof o.state === 'string' && VALID_STATES.includes(o.state)
  );
  if (obj) return { state: obj.state, source: 'llm' };
  return { state: 'unknown', source: 'rule' };
}
