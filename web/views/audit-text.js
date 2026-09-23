/**
 * 稽核軌跡的白話翻譯：一筆紀錄 → 一句「誰做了什麼」。
 *
 * 畫面上不出現程式代碼、JSON 或內部編號。後端已經把人和對象換成名字
 * （actor_label、target_label、subject_label，見 server/routes/shipping.js 的 labelAudit），
 * 這裡只負責把「動作」講成一句話，並把補充資訊寫成看得懂的說明。
 *
 * 新增一種稽核動作時，在 SAY 裡加一行；沒加的會顯示「其他操作」，不會出錯。
 */

const ROLE = { owner: '店主', helper: '日本小幫手', packer: '包貨人員', buyer: '客人' };
const role = (r) => ROLE[r] || r || '—';
const ntd = (v) => (v == null || v === '' ? '—' : 'NT$' + Math.round(Number(v)).toLocaleString('zh-TW'));
const yen = (v) => (v == null || v === '' ? '—' : '¥' + Math.round(Number(v)).toLocaleString('ja-JP'));
const q = (s) => `「${s}」`;

/** 掃碼核對的七道檢查，各自代表什麼。 */
const SCAN = {
  BAD_FORMAT: '掃到的不是本店的標籤',
  ORDER_NOT_FOUND: '找不到這張訂單',
  BAD_SIGNATURE: '標籤不是系統印的（驗證碼不符）',
  ALREADY_SHIPPED: '這張單已經出過貨了',
  UNPAID: '客人還沒付款',
  INCOMPLETE_PROCUREMENT: '還有品項沒買到',
  PASS: '檢查全部通過',
};
const scan = (code) => SCAN[code] || '核對未通過';

const PROC_STATE = { got: '全部買到', partial: '只買到一部分', out_of_stock: '買不到（缺貨）' };

/** 店家設定的欄位名稱。 */
const SHOP_KEY = {
  shop_name: '店名', bank_name: '銀行名稱', bank_code: '銀行代碼', bank_holder: '收款戶名',
  bank_account: '收款帳號', payment_deadline_days: '付款期限', statement_days: '結算日',
  bulky_add_min: '大型品加價下限', bulky_add_max: '大型品加價上限',
  ship_fee_cvs: '超商運費', ship_fee_home: '宅配運費',
};

/**
 * 每種動作一句話。t = 對象的名字（訂單編號、品名…），d = 補充資料，l = 整筆紀錄。
 * 回傳 [做了什麼, 補充說明]。
 */
const SAY = {
  'auth.login': (t, d) => [d && d.via === 'line' ? '用 LINE 登入後台' : '用共用密碼登入後台', ''],

  'order.create': (t, d, l) => [`替 ${l.subject_label || '客人'} 代客下單：訂單 ${t}`,
    d ? `${d.items || 0} 個品項，合計 ${ntd(d.total_twd)}` : ''],
  'order.quote': (t, d) => [`替訂單 ${t} 報價`,
    d ? `${(d.items || []).length} 個品項定價${d.ship_fee_twd != null ? `，運費 ${ntd(d.ship_fee_twd)}` : ''}` : ''],
  'order.transition': (t, d, l) => (l.result === 'blocked'
    ? [`想把訂單 ${t} 從${q(d.from)}改成${q(d.to)}，但不符合訂單流程`, '訂單只能照流程往下走，要倒退請由店主修正']
    : [`把訂單 ${t} 從${q(d.from)}改成${q(d.to)}`, d.reason ? `原因：${d.reason}` : '']),
  'order.transition.forced': (t, d) => [`店主修正訂單 ${t} 的狀態：${q(d.from)} → ${q(d.to)}`, d.reason ? `原因：${d.reason}` : ''],
  'order.split': (t, d, l) => (l.result === 'blocked'
    ? [`想拆分訂單 ${t}，但目前狀態${q(d.status)}不能拆`, '']
    : [`把訂單 ${t} 拆成兩張：新訂單 ${d.child}`, `原本 ${ntd(d.originalTotal)} → 留下 ${ntd(d.parentTotal)}，拆出 ${ntd(d.childTotal)}`]),
  'order.ship': (t, d, l) => (l.result === 'blocked'
    ? [`想把訂單 ${t} 出貨，但客人還沒付款，被擋下`, '要出貨需由店主填寫原因']
    : [`把訂單 ${t} 標記為已出貨`,
      [d.verified_by_scan ? '有經過掃碼核對' : '手動出貨，沒有掃碼核對', d.override_reason ? `例外原因：${d.override_reason}` : ''].filter(Boolean).join('；')]),
  'payment.reconcile': (t, d) => [`核對訂單 ${t} 的付款 ${ntd(d.amount)}`, d.diff ? `與應收金額差 ${ntd(d.diff)}` : '金額相符'],
  'logistics.bind': (t, d) => [`把物流單號 ${d.tracking} 綁到訂單 ${t}`, ''],

  'scan.verify': (t, d) => [`掃描出貨標籤${t ? `（訂單 ${t}）` : ''}`, scan(d.check)],
  'scan.commit': (t, d, l) => (l.result === 'blocked'
    ? [`掃碼出貨被擋下${t ? `：訂單 ${t}` : ''}`, d.check ? scan(d.check) : `訂單狀態${q(d.status)}還不能出貨`]
    : [`掃碼確認出貨：訂單 ${t}`, d.override_reason ? `${scan(d.check)}，例外放行，原因：${d.override_reason}` : '檢查全部通過']),
  'label.print': (t, d) => [`列印出貨標籤 ${d.count} 張`, ''],

  'procurement.claim': (t, d, l) => (l.result === 'blocked'
    ? [`想認領採購「${t}」，但已經有人認領了`, '']
    : [`認領採購「${t}」`, '']),
  'procurement.release': (t) => [`放棄認領採購「${t}」`, ''],
  'procurement.result': (t, d) => [`回報採購結果：「${t}」${PROC_STATE[d.state] || ''}`, `買到 ${d.got_qty} 件`],
  'procurement.expense': (t, d) => [`登錄採購成本：「${t}」`,
    `單價 ${yen(d.unit_cost_jpy)} × ${d.qty} 件，匯率 ${d.fx}${d.amount_edited ? '（金額有手動修改）' : ''}`],

  'batch.create': (t) => [`開新團：${t}`, ''],
  'broadcast.create': (t, d) => [`開喊單：「${t}」`, `數量 ${d.quantity}，售價 ${ntd(d.price_twd)}`],
  'broadcast.close': (t) => [`關閉喊單：「${t}」`, ''],
  'broadcast.adjust': (t, d) => [`調整喊單「${t}」的數量`, `${d.delta > 0 ? '增加' : '減少'} ${Math.abs(d.delta)} 個`],
  'wish.quote': (t, d) => [`替許願「${t}」報價 ${ntd(d.quote_twd)}`, ''],
  'wish.mark': (t, d) => [`把許願「${t}」標記為${q(d.status)}`, ''],

  'statements.generate': (t, d) => [`產生對帳單 ${d.created} 張`, ''],
  'statement.reconcile': (t, d) => [`核對對帳單 ${t} 的收款 ${ntd(d.amount)}`, d.diff ? `與應收金額差 ${ntd(d.diff)}` : '金額相符'],

  'settings.fx': (t, d) => [`把匯率從 ${d.from} 改成 ${d.to}`, '已經登錄的成本不會跟著改'],
  'settings.batch': (t, d) => [`把目前的團切換成 ${d.batch}`, ''],
  'settings.shop': (t, d) => ['修改店家與收款設定', `改了：${(d.keys || []).map((k) => SHOP_KEY[k] || k).join('、') || '—'}`],
  'settings.price_table': (t, d) => ['更新價目表', `由 ${(d.before || []).length} 級改為 ${(d.after || []).length} 級`],

  'members.role': (t, d, l) => [`把 ${l.subject_label || '一位成員'} 的角色從${q(role(d.from))}改成${q(role(d.to))}`, ''],
  'members.add': (t, d, l) => [`新增員工 ${l.subject_label || ''}，角色為${q(role(d.role))}`, ''],
};

/** 一筆紀錄 → { who, what, note, result: { text, tone } } */
export function describe(l) {
  const d = l.detail || {};
  const t = l.target_label || l.target || '';
  const say = SAY[l.action];
  let what = '其他操作';
  let note = '';
  if (say) {
    try { [what, note] = say(t, d, l); } catch { what = '其他操作'; }
  }
  return {
    who: l.actor_label || '系統自動',
    what,
    note: note || '',
    result: RESULT[l.result] || { text: '—', tone: '' },
  };
}

export const RESULT = {
  ok: { text: '正常', tone: 'green' },
  warn: { text: '例外放行', tone: 'amber' },
  blocked: { text: '被擋下', tone: 'red' },
};
