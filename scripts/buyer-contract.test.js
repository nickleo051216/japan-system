// 合約測試：之後把 BASE 換成真正的 japan-system，同一份測試再跑一次
const BASE = process.env.BASE || 'http://127.0.0.1:4011/api/v1';
// 對參考實作用 test-idtoken；對真後端由 scripts/contract-run.js 注入一張真的 token。
const H = { 'Content-Type':'application/json', Authorization:'Bearer ' + (process.env.BUYER_TOKEN || 'test-idtoken') };
let pass=0, fail=0;
const ok=(n,c,d='')=>{c?pass++:fail++;console.log(`  ${c?'✓':'✗'} ${n}${d?' — '+d:''}`)};
const call=async(m,p,b,extra={})=>{const r=await fetch(BASE+p,{method:m,headers:{...H,...extra},body:b?JSON.stringify(b):undefined});
  return {status:r.status,json:await r.json()}};
const G=(p)=>call('GET',p); const P=(p,b,k)=>call('POST',p,b,k?{'Idempotency-Key':k}:{});
const env=(r)=>'ok' in r.json && 'data' in r.json && 'error' in r.json;
(async()=>{
  if(!process.env.BASE) await fetch(BASE.replace('/api/v1','/__reset'));
  console.log('【信封與身分】');
  let r=await fetch(BASE+'/me/profile'); ok('沒帶 token → 401 UNAUTHENTICATED', r.status===401 && (await r.json()).error.code==='UNAUTHENTICATED');
  r=await G('/nope/x'); ok('不存在的 API → 404 NOT_FOUND', r.status===404 && r.json.error.code==='NOT_FOUND');
  r=await G('/me/profile'); ok('回應一律 {ok,data,error}', env(r) && r.json.ok===true && r.json.error===null);
  ok('會員資料欄位', ['line_user_id','nickname','cvs_store_name','carrier','shout_drops'].every(k=>k in r.json.data));

  console.log('\n【首頁】');
  r=await G('/home/summary'); const h=r.json.data;
  ok('首頁一次取回 shop/batch/價目表/喊單/待辦', ['shop','batch','price_table','broadcast','todo'].every(k=>k in h));
  ok('價目表 11 級距', h.price_table.length===11 && h.price_table[1].twd===220);
  ok('喊單附 open 旗標（已截止＝false）', h.broadcast.find(b=>b.send_id==='BC-0913-001').open===false);

  console.log('\n【購物車】');
  r=await P('/cart/add-text',{name:'  '}); ok('空白品名 → 400 BAD_NAME', r.status===400 && r.json.error.code==='BAD_NAME');
  r=await P('/cart/add-text',{name:'Pigeon 奶瓶',jpy_taxed:1000,qty:2},'k-text-1');
  const t1=r.json.data; ok('文字下單 → pending + 級距價', t1.status==='pending' && t1.price_twd===400, `¥1000→${t1.price_twd}`);
  r=await P('/cart/add-text',{name:'Pigeon 奶瓶',jpy_taxed:1000,qty:2},'k-text-1');
  const n=(await G('/cart/list')).json.data.length;
  ok('同一 Idempotency-Key 重送不會重複建立', r.json.data.cart_id===t1.cart_id && n===1, `購物車 ${n} 筆`);
  r=await P('/cart/add-image',{file_name:'IMG_001.jpg',data:'xx'}); ok('圖片檔名不符規則 → BAD_FILE_NAME', r.json.error?.code==='BAD_FILE_NAME');
  r=await P('/cart/add-image',{file_name:'ocr_temp_2993299f_202609221430123.jpg',data:'base64'});
  const im=r.json.data; ok('拍照下單 → pending、低信心、待報價', im.status==='pending' && im.ai_confidence==='low' && im.price_twd===null);
  r=await P('/cart/update',{cart_id:im.cart_id,name:'EDWIN 牛仔褲',jpy_taxed:2519});
  ok('修改內容 → 自動確認並重算價格', r.json.data.status==='confirmed' && r.json.data.price_twd===890);
  r=await P('/cart/confirm',{cart_ids:[t1.cart_id]}); ok('確認品項', r.json.data.confirmed.includes(t1.cart_id));

  console.log('\n【喊單】');
  r=await P('/broadcast/shout',{send_id:'BC-0913-002',qty:9});
  ok('喊 9 剩 3 → 得 3', r.json.data.granted===3 && r.json.data.remaining===0, JSON.stringify({g:r.json.data.granted,left:r.json.data.remaining}));
  ok('喊單品項直接為 confirmed', r.json.data.cart_item.status==='confirmed');
  const bcCart=r.json.data.cart_item.cart_id;
  r=await P('/broadcast/shout',{send_id:'BC-0913-002',qty:1}); ok('搶完 → 409 SOLD_OUT', r.status===409 && r.json.error.code==='SOLD_OUT');
  r=await P('/broadcast/shout',{send_id:'BC-0913-001',qty:1}); ok('已截止 → 409 DEADLINE_PASSED', r.status===409 && r.json.error.code==='DEADLINE_PASSED');
  r=await P('/cart/update',{cart_id:bcCart,name:'改名'}); ok('喊單品項不能改內容 → 409 NOT_EDITABLE', r.json.error?.code==='NOT_EDITABLE');
  r=await P('/broadcast/waitlist',{send_id:'BC-0913-002',on:true}); ok('排候補', r.json.data.waitlisted===true);
  r=await P('/cart/remove',{cart_id:bcCart}); ok('取消喊單 → 記棄單、餘量回補', r.json.data.shout_drops===1);
  ok('餘量已回補', (await G('/home/summary')).json.data.broadcast.find(b=>b.send_id==='BC-0913-002').remaining===3);

  console.log('\n【許願】');
  r=await P('/wishes/create',{src:'link',ref_url:'rakuten.co.jp/x'}); ok('連結不完整 → BAD_URL', r.json.error?.code==='BAD_URL');
  r=await P('/wishes/create',{src:'text',item_name:'阪急嬰兒襪',quantity:3}); ok('文字許願 → 待處理', r.json.data.wish_status==='待處理');
  r=await P('/wishes/to-cart',{wish_id:r.json.data.wish_id}); ok('未報價不能加購物車 → 409 NOT_QUOTED', r.json.error?.code==='NOT_QUOTED');
  r=await P('/wishes/to-cart',{wish_id:'W-104'}); ok('已報價許願 → 加入購物車（已確認）', r.json.data.cart_item.status==='confirmed' && r.json.data.wish.wish_status==='已下單');

  console.log('\n【結帳與訂單】');
  await P('/cart/add-text',{name:'還沒確認的品項',qty:1});
  const cart=(await G('/cart/list')).json.data;
  ok('結帳前購物車有待確認品項', cart.some(c=>c.status==='pending'));
  r=await P('/orders/checkout',{cart_ids:cart.map(c=>c.cart_id),pickup:{type:'cvs'},invoice:{type:'carrier'}});
  ok('含未確認品項 → 409 NOT_CONFIRMED', r.json.error?.code==='NOT_CONFIRMED');
  const conf=cart.filter(c=>c.status==='confirmed').map(c=>c.cart_id);
  r=await P('/orders/checkout',{cart_ids:conf,pickup:{type:'cvs'},invoice:{type:'tax',tax_id:'123'}});
  ok('統編非 8 碼 → BAD_TAX_ID', r.json.error?.code==='BAD_TAX_ID');
  r=await P('/orders/checkout',{cart_ids:conf,pickup:{type:'cvs'},invoice:{type:'carrier'},note:'低調包裝'},'k-co-1');
  const o=r.json.data; ok('送出訂單 → 待確認／待付款', o.status==='待確認' && o.payment_status==='待付款', `${o.order_id} NT$${o.total_twd}`);
  r=await P('/orders/checkout',{cart_ids:conf,pickup:{type:'cvs'},invoice:{type:'carrier'}},'k-co-1');
  ok('結帳重送不會成立第二張單', r.json.data.order_id===o.order_id);
  ok('已送出品項離開購物車', !(await G('/cart/list')).json.data.some(c=>conf.includes(c.cart_id)));
  r=await G('/orders/list'); ok('訂單列表含品項與狀態紀錄', r.json.data[0].items.length>0 && Array.isArray(r.json.data[0].status_log));
  r=await P('/orders/split-request',{order_id:'ORD-20260901-014',on:true}); ok('部分到貨 → 可申請先出貨', r.json.data.split_shipped===true);
  r=await P('/orders/split-request',{order_id:o.order_id,on:true}); ok('待確認訂單不能拆 → 409', r.json.error?.code==='NOT_SPLITTABLE');
  r=await P('/orders/received',{order_id:'ORD-20260901-014'}); ok('未出貨不能按收到 → 409 ILLEGAL_TRANSITION', r.json.error?.code==='ILLEGAL_TRANSITION');
  r=await G('/shipments/track?order_id=ORD-20260828-007'); ok('物流追蹤含貨態事件', r.json.data[0].events.length>0);

  console.log('\n【對帳單與付款】');
  r=await G('/statements/list'); ok('對帳單列表＋未結算彙總', Array.isArray(r.json.data.statements) && 'unbilled' in r.json.data);
  r=await P('/statements/report-transfer',{statement_id:'STMT-20260916-0032',last5:'12'}); ok('末五碼非 5 碼 → BAD_LAST5', r.json.error?.code==='BAD_LAST5');
  r=await P('/statements/pay-init',{statement_id:'STMT-20260916-0032',payway:'atm'});
  const va=r.json.data.v_account; ok('ATM → 虛擬帳號', r.json.data.flow==='vacc' && !!va, va);
  r=await P('/statements/pay-init',{statement_id:'STMT-20260916-0032',payway:'atm'}); ok('重複取號回同一組帳號', r.json.data.v_account===va);
  r=await P('/statements/pay-init',{statement_id:'STMT-20260916-0032',payway:'credit'}); ok('信用卡 → 導轉表單', r.json.data.flow==='redirect' && !!r.json.data.action);
  r=await P('/statements/report-transfer',{statement_id:'STMT-20260916-0032',last5:'48210'}); ok('回報末五碼 → 待官方確認', r.json.data.payment_status==='待官方確認');
  r=await P('/statements/pay-init',{statement_id:'STMT-20260901-0031',payway:'credit'}); ok('已付清不能再付 → 409 ALREADY_PAID', r.json.error?.code==='ALREADY_PAID');

  console.log('\n【我的】');
  r=await P('/me/update',{phone:'123'}); ok('手機格式錯 → BAD_PHONE', r.json.error?.code==='BAD_PHONE');
  r=await P('/me/update',{carrier:'ABC'}); ok('載具格式錯 → BAD_CARRIER', r.json.error?.code==='BAD_CARRIER');
  r=await P('/me/update',{nickname:'小周',cvs_brand:'全家',cvs_store_name:'板橋溪城店',cvs_store_id:'012345'});
  ok('更新暱稱與取貨門市', r.json.data.nickname==='小周' && r.json.data.cvs_store_name==='板橋溪城店');

  console.log(`\n合約測試：${pass} 通過 / ${fail} 失敗`);
  process.exit(fail?1:0);
})();
