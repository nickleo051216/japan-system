'use strict';
/**
 * 許願牆的共用規則。
 *
 * 「看不懂的許願」：照片許願沒填品名時，品名會是預設的「照片許願」。
 * 如果又沒有照片（v1.5 之前的照片許願不存圖），牆上就是一張看不出是什麼的空白卡片，
 * 別人也無從 +1。這種許願不能上牆、許願牆不列、也不能 +1。
 * 店家在「放上牆」時補一個品名，就不算看不懂了。
 */
const PHOTO_PLACEHOLDER = '照片許願';

/** 給 SQL 用：w 是 wishlist 的別名。 */
const READABLE_SQL = `NOT (w.item_name = '${PHOTO_PLACEHOLDER}' AND w.picture IS NULL)`;

const isUnreadable = (w) => w.item_name === PHOTO_PLACEHOLDER && !w.picture;

module.exports = { PHOTO_PLACEHOLDER, READABLE_SQL, isUnreadable };
