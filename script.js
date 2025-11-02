/* script.js
  重要:
  - localStorageを使って通知データを保存します（キー: ns_notifications）
  - setTimeoutでページが開いている時は確実に通知を出します
  - Service Worker registrationとPeriodic Sync（利用できる場合）を試みます
  - ブラウザがPeriodic Syncをサポートしていない場合は、ページが閉じているときに通知が来ない可能性があります（対策はWeb Pushサーバーを用意すること）
*/

const STORAGE_KEY = 'ns_notifications';
const notifArea = document.getElementById('notifArea');
const ding = document.getElementById('ding');

let deferredPrompt = null;
let timeouts = new Map(); // id -> timeoutId

document.addEventListener('DOMContentLoaded', init);

async function init(){
  // fade-in fix for animation
  document.body.style.opacity = 1;

  // UI bindings
  document.getElementById('mode').addEventListener('change', onModeChange);
  document.getElementById('createForm').addEventListener('submit', onCreate);
  document.getElementById('repeatAt').addEventListener('change', onRepeatAtChange);
  document.getElementById('requestPermission').addEventListener('click', requestPermission);
  document.getElementById('installPWA').addEventListener('click', installPWA);

  // attempt service worker registration
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      console.log('SW registered', reg);
      // try to register periodic sync if available
      if ('periodicSync' in reg) {
        try {
          // request permission via periodicSync (may prompt or fail)
          await reg.periodicSync.register('ns-periodic-sync', {minInterval: 15 * 60 * 1000});
          console.log('Periodic Sync registered');
        } catch (e) {
          console.log('Periodic Sync not available or denied', e);
        }
      }
    } catch (e) {
      console.warn('SW register failed', e);
    }
  }

  // PWA install prompt capture
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    document.getElementById('installPWA').style.display = 'inline-block';
  });

  loadList();
  scheduleAllFromStorage();
}

// UI helpers
function onModeChange(e){
  const v = e.target.value;
  document.getElementById('afterInputs').style.display = v === 'after' ? '' : 'none';
  document.getElementById('atInputs').style.display = v === 'at' ? '' : 'none';
}

function onRepeatAtChange(e){
  const v = e.target.value;
  document.getElementById('weeklySelect').style.display = v === 'weekly' ? '' : 'none';
  document.getElementById('monthlySelect').style.display = v === 'monthly' ? '' : 'none';
}

function installPWA(){
  if (deferredPrompt) {
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then((choice) => {
      deferredPrompt = null;
      document.getElementById('installPWA').style.display = 'none';
    });
  }
}

async function requestPermission(){
  if (!('Notification' in window)) {
    alert('このブラウザは通知に対応していません。');
    return;
  }
  const res = await Notification.requestPermission();
  if (res === 'granted') alert('通知が許可されました。');
  else alert('通知が許可されませんでした。');
}

// storage helpers
function loadNotifications(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch (e) { return []; }
}
function saveNotifications(list){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  // notify SW about updated list (best-effort)
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({type:'updateNotifications'});
  }
}

function generateId(){
  return 'n_' + Date.now() + '_' + Math.floor(Math.random()*10000);
}

// create handler
function onCreate(e){
  e.preventDefault();
  const msg = document.getElementById('message').value.trim();
  if (!msg) return alert('メッセージを入力してください');

  const mode = document.getElementById('mode').value;
  const tz = document.getElementById('timezone').value;
  const notifyType = document.getElementById('notifyType').value;
  const soundOn = document.getElementById('soundToggle')?.checked ?? true;

  const item = {
    id: generateId(),
    message: msg,
    mode,
    notifyType,
    tz,
    soundOn,
    createdAt: Date.now(),
    enabled: true
  };

  if (mode === 'after') {
    const h = Math.max(0, parseInt(document.getElementById('hours').value) || 0);
    const m = Math.max(0, parseInt(document.getElementById('minutes').value) || 0);
    const loop = Math.max(0, parseInt(document.getElementById('loopCount').value) || 0);
    item.after = {hours:h, minutes:m, loopCount: loop, remainingLoops: loop};
    // compute nextTime in ms
    item.nextTime = Date.now() + ((h*60 + m) * 60 * 1000);
  } else {
    const hr = parseInt(document.getElementById('hourAt').value);
    const min = parseInt(document.getElementById('minuteAt').value);
    if (Number.isNaN(hr) || Number.isNaN(min)) return alert('時刻を入力してください');
    item.at = {hour: hr, minute: min};
    item.repeatAt = document.getElementById('repeatAt').value;
    if (item.repeatAt === 'weekly') {
      const checked = Array.from(document.querySelectorAll('#weeklySelect input[type=checkbox]:checked')).map(c => parseInt(c.value));
      if (!checked.length) return alert('曜日を1つ以上選択してください');
      item.weekdays = checked;
    } else if (item.repeatAt === 'monthly') {
      const day = parseInt(document.getElementById('monthDay').value);
      if (!day || day < 1 || day > 31) return alert('正しい日付を入力してください (1-31)');
      item.monthDay = day;
    }
    // compute nextTime considering timezone
    item.nextTime = computeNextAtTime(item.at.hour, item.at.minute, item.repeatAt, item.weekdays, item.monthDay, item.tz);
  }

  // save
  const list = loadNotifications();
  list.push(item);
  saveNotifications(list);
  loadList();
  scheduleNotification(item);
  document.getElementById('createForm').reset();
  onModeChange({target:document.getElementById('mode')});
  alert('通知を登録しました');
}

// computing next occurrence for "at" mode (minutes precision)
function computeNextAtTime(hour, minute, repeatAt, weekdays, monthDay, tz) {
  // Use Date in specified timezone by creating a Date for now in UTC then shifting by timezone offset using Intl
  // Simpler approach: compute based on local time but adjust to chosen timezone by using Date.toLocaleString
  const now = new Date();
  // Convert "now" to the target timezone hour/minute by leveraging Intl
  // We'll compute target time in the timezone, then convert to epoch ms
  function toTZDate(year, monthIndex, day, h, m, tz) {
    // Build an ISO string like "YYYY-MM-DDTHH:MM:SS" and interpret in that timezone by using Date.toLocaleString hack
    // Because JS cannot easily create a Date directly in a named timezone, we'll compute the offset difference.
    // Simpler fallback: assume tz is same as current environment (best-effort). For robust tz handling, use a library like dayjs/timezone.
    const d = new Date(year, monthIndex, day, h, m, 0, 0);
    return d.getTime();
  }

  // find candidate next date
  let candidate = new Date();
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    // move to next day
    candidate.setDate(candidate.getDate() + 1);
  }

  if (repeatAt === 'none') {
    return candidate.getTime();
  } else if (repeatAt === 'weekly' && Array.isArray(weekdays) && weekdays.length) {
    // find next day matching one of weekdays (0=Sun)
    for (let i=0;i<14;i++){
      const d = new Date();
      d.setDate(now.getDate() + i);
      d.setHours(hour, minute,0,0);
      if (d.getTime() > now.getTime() && weekdays.includes(d.getDay())) return d.getTime();
    }
    return candidate.getTime();
  } else if (repeatAt === 'monthly' && monthDay) {
    // next month day
    let d = new Date(now.getFullYear(), now.getMonth(), monthDay, hour, minute,0,0);
    if (d.getTime() <= now.getTime()) {
      d = new Date(now.getFullYear(), now.getMonth()+1, monthDay, hour, minute,0,0);
    }
    return d.getTime();
  }
  return candidate.getTime();
}

// load and render list
function loadList(){
  const list = loadNotifications();
  const lc = document.getElementById('listContainer');
  lc.innerHTML = '';
  if (!list.length) { lc.innerHTML = '<p class="muted">登録された通知はありません。</p>'; return; }
  list.forEach(item => {
    const el = document.createElement('div');
    el.className = 'notification-item';
    const left = document.createElement('div');
    left.innerHTML = `<div><strong>${escapeHtml(item.message)}</strong></div><div class="meta">${new Date(item.nextTime).toLocaleString()}</div>`;
    const right = document.createElement('div');
    right.className = 'notification-actions';
    const toggleBtn = document.createElement('button');
    toggleBtn.textContent = item.enabled ? '停止' : '有効化';
    toggleBtn.onclick = () => { toggleEnable(item.id); };
    const editBtn = document.createElement('button');
    editBtn.textContent = '編集';
    editBtn.onclick = () => { alert('編集機能は後で追加できます（今は削除→再登録で対応）'); };
    const delBtn = document.createElement('button');
    delBtn.textContent = '削除';
    delBtn.onclick = () => { deleteNotification(item.id); };
    right.appendChild(toggleBtn); right.appendChild(editBtn); right.appendChild(delBtn);
    el.appendChild(left); el.appendChild(right);
    lc.appendChild(el);
  });
}

// schedule existing notifications on load
function scheduleAllFromStorage(){
  const list = loadNotifications();
  list.forEach(scheduleNotification);
}

function scheduleNotification(item){
  // clear existing
  if (timeouts.has(item.id)) {
    clearTimeout(timeouts.get(item.id));
    timeouts.delete(item.id);
  }
  if (!item.enabled) return;

  const now = Date.now();
  const delay = Math.max(0, item.nextTime - now);
  // minimum resolution minute; convert ms to minute-granularity
  const msDelay = delay;
  // don't schedule huge delays? setTimeout supports large delays but SW might be better — still we schedule
  const tid = setTimeout(async () => {
    // Fire notification
    await fireNotification(item);
    // handle rescheduling
    if (item.mode === 'after') {
      // if loopCount>0 - decrement and reschedule
      if (item.after.loopCount > 0) {
        if (item.after.remainingLoops > 1) {
          item.after.remainingLoops -= 1;
          item.nextTime = Date.now() + ((item.after.hours*60 + item.after.minutes) * 60 * 1000);
          updateItem(item);
          scheduleNotification(item);
        } else {
          // last loop done; disable if loopCount was >0 and remaining now 1 => after showing we finish
          item.enabled = false;
          updateItem(item);
        }
      } else {
        // not looping
        item.enabled = false;
        updateItem(item);
      }
    } else if (item.mode === 'at') {
      if (item.repeatAt === 'none') {
        item.enabled = false;
        updateItem(item);
      } else {
        // compute nextTime again
        item.nextTime = computeNextAtTime(item.at.hour, item.at.minute, item.repeatAt, item.weekdays, item.monthDay, item.tz);
        updateItem(item);
        scheduleNotification(item);
      }
    }
  }, msDelay);
  timeouts.set(item.id, tid);
}

// show notification (browser + in-page)
async function fireNotification(item){
  // Browser Notification via Notification API (and via SW showNotification)
  if ((item.notifyType === 'browser' || item.notifyType === 'both')) {
    if (Notification.permission === 'granted') {
      // if service worker controller exists, try to show via SW for better background behavior
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        try {
          navigator.serviceWorker.controller.postMessage({type:'showNotification', payload:item});
        } catch (e) {
          // fallback
          new Notification(item.message);
        }
      } else {
        new Notification(item.message);
      }
    }
  }

  // in-page LINE風 popup
  if (item.notifyType === 'popup' || item.notifyType === 'both') {
    showInPageNotif(item);
  }

  // sound
  if (item.soundOn && document.getElementById('soundToggle')?.checked) {
    try { ding.currentTime = 0; ding.play(); } catch(e){}
  }

  // Save to history (append history meta)
  appendHistoryEntry(item);
}

// in-page notification UI
function showInPageNotif(item){
  const d = document.createElement('div');
  d.className = 'notif';
  d.innerHTML = `<div class="icon">🔔</div><div class="body"><p>${escapeHtml(item.message)}</p><span>${new Date().toLocaleString()}</span></div>`;
  notifArea.prepend(d);
  // auto dismiss after 4s
  setTimeout(()=> {
    d.style.animation = 'notifOut 0.3s forwards';
    setTimeout(()=> d.remove(), 300);
  }, 4000);
}

// append history (we'll add a small history array in the item)
function appendHistoryEntry(item){
  const list = loadNotifications();
  const idx = list.findIndex(x => x.id === item.id);
  if (idx >= 0) {
    list[idx].history = list[idx].history || [];
    list[idx].history.push({ts: Date.now(), message: item.message});
    saveNotifications(list);
    loadList();
  }
}

function updateItem(item){
  const list = loadNotifications();
  const idx = list.findIndex(x => x.id === item.id);
  if (idx >= 0) {
    list[idx] = item;
    saveNotifications(list);
    loadList();
  }
}

function deleteNotification(id){
  if (!confirm('この通知を削除しますか？')) return;
  const list = loadNotifications().filter(x => x.id !== id);
  saveNotifications(list);
  loadList();
  if (timeouts.has(id)) {
    clearTimeout(timeouts.get(id));
    timeouts.delete(id);
  }
}

function toggleEnable(id){
  const list = loadNotifications();
  const idx = list.findIndex(x => x.id === id);
  if (idx>=0) {
    list[idx].enabled = !list[idx].enabled;
    if (list[idx].enabled) {
      // recompute nextTime for safety
      if (list[idx].mode === 'after') {
        list[idx].nextTime = Date.now() + ((list[idx].after.hours*60 + list[idx].after.minutes)*60*1000);
        list[idx].after.remainingLoops = list[idx].after.loopCount;
      } else {
        list[idx].nextTime = computeNextAtTime(list[idx].at.hour, list[idx].at.minute, list[idx].repeatAt, list[idx].weekdays, list[idx].monthDay, list[idx].tz);
      }
      saveNotifications(list);
      scheduleNotification(list[idx]);
    } else {
      saveNotifications(list);
      if (timeouts.has(id)) { clearTimeout(timeouts.get(id)); timeouts.delete(id); }
    }
    loadList();
  }
}

// Utility
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }


// send notifications list to SW on demand
navigator.serviceWorker?.addEventListener('message', (e) => {
  // handle messages from sw if needed
  // console.log('SW->client', e.data);
});

// Expose method for SW to request current notifications (SW cannot access localStorage)
navigator.serviceWorker?.addEventListener('message', async (event) => {
  // if SW asks for list, reply
  if (event.data && event.data.type === 'requestNotifications') {
    const list = loadNotifications();
    // send to SW
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({type:'deliverNotifications', payload:list});
    }
  }
});