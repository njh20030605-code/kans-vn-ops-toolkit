import { warn, info } from './util.js';

/**
 * 可插拔 LLM 适配层。OpenAI 兼容 chat/completions。
 * 只做判断/分类/映射,绝不触发任何副作用动作。
 * 所有调用都必须有确定性回退;LLM 不可用/超时/非法输出一律返回 null,由调用方走回退。
 */
export class LlmClient {
  constructor(cfg) {
    this.cfg = cfg || { enabled: false };
    this.callsThisRun = 0;
  }

  resetRun() {
    this.callsThisRun = 0;
  }

  get available() {
    return !!(this.cfg.enabled && this.cfg.apiKey && this.cfg.baseUrl && this.cfg.model);
  }

  /**
   * 让 LLM 返回一个 JSON 对象。validate(obj)->bool 做 schema 校验。
   * 返回校验通过的对象,或 null(不可用/超限/超时/非法)。
   */
  async askJson(system, user, validate) {
    if (!this.available) return null;
    if (this.callsThisRun >= (this.cfg.maxCallsPerRun ?? 10)) {
      warn('LLM 已达本轮调用上限,走回退');
      return null;
    }
    this.callsThisRun++;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs || 30000);
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: this.cfg.model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        warn('LLM 非 2xx:', res.status);
        return null;
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) return null;
      let obj;
      try {
        obj = JSON.parse(content);
      } catch {
        warn('LLM 输出非合法 JSON,走回退');
        return null;
      }
      if (typeof validate === 'function' && !validate(obj)) {
        warn('LLM 输出未通过 schema 校验,走回退');
        return null;
      }
      info('LLM 判断:', obj);
      return obj;
    } catch (e) {
      warn('LLM 调用异常/超时,走回退:', e.message || String(e));
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
