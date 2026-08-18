'use strict';
const db = require('../lib/db');
const { get, post, ok } = require('../lib/http');
const auth = require('../lib/auth');
const audit = require('../lib/audit');

const err = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

/**
 * Prototype login: pick one of the seeded personas. Production replaces this
 * with LIFF ID Token verification (I-02) — the token shape and the server-side
 * role resolution stay the same.
 */
get('/api/v1/auth/personas', () =>
  ok(db.all("SELECT line_user_id, nickname, display_name, role FROM members ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'helper' THEN 1 WHEN 'packer' THEN 2 ELSE 3 END, nickname")));

post('/api/v1/auth/login', ({ body }) => {
  const member = db.one('SELECT * FROM members WHERE line_user_id = ?', body.line_user_id);
  if (!member) throw err('NO_SUCH_MEMBER', '查無此使用者', 404);
  audit.record({ actor: member.line_user_id, action: 'auth.login', result: 'ok' });
  return ok({
    token: auth.issue(member.line_user_id),
    member: { line_user_id: member.line_user_id, nickname: member.nickname, display_name: member.display_name, role: member.role },
    capabilities: Object.keys(auth.CAPABILITIES).filter((c) => auth.can(member, c)),
  });
});

get('/api/v1/auth/me', ({ actor }) => {
  if (!actor) throw err('UNAUTHENTICATED', '尚未登入', 401);
  return ok({ member: actor, capabilities: Object.keys(auth.CAPABILITIES).filter((c) => auth.can(actor, c)) });
});
