const fs = require('fs'), os = require('os'), path = require('path');
const BASE = 'https://open.feishu.cn';
let _t = null;
function creds() {
  let id = process.env.FEISHU_APP_ID, secret = process.env.FEISHU_APP_SECRET;
  if (!id || !secret) {
    const f = path.join(os.homedir(), '.feishu', 'credentials.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    id = id || j.app_id; secret = secret || j.app_secret;
  }
  return { id, secret };
}
async function token() {
  if (_t) return _t;
  const { id, secret } = creds();
  const r = await fetch(`${BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: id, app_secret: secret }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('token fail ' + JSON.stringify(j));
  _t = j.tenant_access_token; return _t;
}
async function api(method, p, body) {
  const t = await token();
  const r = await fetch(BASE + p, {
    method, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`${method} ${p} -> code=${j.code} msg=${j.msg} ${JSON.stringify(j.error||{})}`);
  return j.data;
}
module.exports = { api, token };
