'use strict';
/**
 * 對帳單結算日（2026-11-25 Nick：每月 15 日、月底自動結算）。
 *
 * 店主在「店家與收款設定」的「對帳單結算日」填，例如 `15,月底`、`1,16`。
 * 「月底」= 那個月的最後一天（28、29、30 或 31 日都對）。沒填就用 15,月底。
 * 一律用台灣日期判斷 —— 伺服器在東京、排程用 UTC，但周小姐的月底是台灣的月底。
 */
const DEFAULT = '15,月底';
const END = '月底';

/** 台灣今天：{ y, m (1–12), d, ymd: 'YYYY-MM-DD', last: 這個月最後一天 } */
function taipeiToday(at = new Date()) {
  const t = new Date(at.getTime() + 8 * 3600_000);
  const y = t.getUTCFullYear(); const m = t.getUTCMonth() + 1; const d = t.getUTCDate();
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { y, m, d, last, ymd: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
}

/** '15,月底' → [15, '月底']。不認得的字直接略過。 */
function parse(raw) {
  const out = [];
  for (const tok of String(raw || DEFAULT).split(/[,，\s]+/).filter(Boolean)) {
    if (tok === END || /^(end|last)$/i.test(tok)) { if (!out.includes(END)) out.push(END); continue; }
    const n = Number(tok);
    if (Number.isInteger(n) && n >= 1 && n <= 28 && !out.includes(n)) out.push(n);
  }
  return out.length ? out : parse(DEFAULT);
}

/** 今天（台灣）是不是結算日 */
function isDue(raw, at = new Date()) {
  const { d, last } = taipeiToday(at);
  return parse(raw).some((x) => (x === END ? d === last : x === d));
}

/** 下一個結算日（含今天），'YYYY-MM-DD'。給前台顯示「下次結算」。 */
function nextDue(raw, at = new Date()) {
  const days = parse(raw);
  for (let i = 0; i < 62; i++) {
    const probe = new Date(at.getTime() + i * 86400_000);
    const { d, last, ymd } = taipeiToday(probe);
    if (days.some((x) => (x === END ? d === last : x === d))) return ymd;
  }
  return null;
}

module.exports = { DEFAULT, END, taipeiToday, parse, isDue, nextDue };
