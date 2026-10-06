/**
 * Nagging Reminder: Google Calendar -> ntfy, nags until Done (spec v3).
 * Single file. Pure helpers come first (no Apps Script globals) so that
 * logic.test.js can load them in Node. Apps Script glue follows.
 */

// ===================== Constants (edit, then deploy a NEW VERSION) =====================
var CAL_HIGH_NAME = 'High';              // overridable with script property CAL_HIGH
var CAL_NORMAL_NAME = 'Normal'; // overridable with script property CAL_NORMAL

var TZ = 'Europe/Paris';
var LOOKBACK_DAYS = 14;
var DEFAULT_TIME = { h: 9, m: 0 };       // due time of all-day events
var QUIET_START = { h: 22, m: 0 };
var QUIET_END = { h: 7, m: 0 };
var EMAIL_AFTER_MIN = 120;
var DAILY_SOFT_LIMIT = 200;
var SEND_FAIL_EMAIL_AFTER = 3;
var DEADMAN_DELAY = '3h';
var NTFY_URL = 'https://ntfy.sh/';

// First reminder at start time, second after secondDelayMin, then repeats forever.
var PROFILES = {
  h: { label: 'High priority',   first: 4, second: 5, secondDelayMin: 10, repeat: 5, repeatMin: 15 },
  n: { label: 'Normal priority', first: 3, second: 4, secondDelayMin: 20, repeat: 4, repeatMin: 30 }
};

var MIN = 60000;
var DAY = 86400000;

// ===================== Pure helpers =====================

/** Europe/Paris UTC offset in minutes at a given instant (EU DST rule). */
function parisOffsetMin(ms) {
  var y = new Date(ms).getUTCFullYear();
  var start = lastSundayUtc(y, 2) + 3600000;  // last Sunday of March, 01:00 UTC
  var end = lastSundayUtc(y, 9) + 3600000;    // last Sunday of October, 01:00 UTC
  return (ms >= start && ms < end) ? 120 : 60;
}

/** Midnight UTC of the last Sunday of the given month (0-based). */
function lastSundayUtc(year, month) {
  var last = new Date(Date.UTC(year, month + 1, 0));
  return Date.UTC(year, month, last.getUTCDate() - last.getUTCDay());
}

/** Local (Paris) wall-clock parts of an instant. */
function localParts(ms) {
  var d = new Date(ms + parisOffsetMin(ms) * MIN);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay()
  };
}

/** Instant of a Paris wall-clock time. Day overflow (d = 0, 32...) is allowed. */
function localToMs(y, mo, d, h, mi) {
  var t = Date.UTC(y, mo - 1, d, h, mi);
  var off = parisOffsetMin(t - 120 * MIN);
  var ms = t - off * MIN;
  var off2 = parisOffsetMin(ms);
  if (off2 !== off) ms = t - off2 * MIN;
  return ms;
}

function minutesOfDay(ms) {
  var p = localParts(ms);
  return p.h * 60 + p.mi;
}

function inQuiet(ms) {
  var m = minutesOfDay(ms);
  var qs = QUIET_START.h * 60 + QUIET_START.m;
  var qe = QUIET_END.h * 60 + QUIET_END.m;
  return m >= qs || m < qe;
}

/** First instant at or after ms that is outside quiet hours. */
function quietEndFrom(ms) {
  if (!inQuiet(ms)) return ms;
  var p = localParts(ms);
  var dayOffset = (p.h * 60 + p.mi >= QUIET_END.h * 60 + QUIET_END.m) ? 1 : 0;
  return localToMs(p.y, p.mo, p.d + dayOffset, QUIET_END.h, QUIET_END.m);
}

/** Pushes a follow-up time out of quiet hours. */
function adjustForQuiet(ms) {
  return quietEndFrom(ms);
}

/** Due time: start time, or DEFAULT_TIME on that day for all-day events. */
function dueMsFor(startMs, allDay) {
  if (!allDay) return startMs;
  var p = localParts(startMs);
  return localToMs(p.y, p.mo, p.d, DEFAULT_TIME.h, DEFAULT_TIME.m);
}

function priorityFor(profile, step) {
  var p = PROFILES[profile];
  if (step <= 0) return p.first;
  if (step === 1) return p.second;
  return p.repeat;
}

/** Delay in minutes after sending reminder number `stepSent` (0 = first). */
function delayAfterMin(profile, stepSent) {
  var p = PROFILES[profile];
  return stepSent <= 0 ? p.secondDelayMin : p.repeatMin;
}

/** nextAt after sending. The first reminder is never held; follow-ups are. */
function nextAtAfterSend(profile, stepSent, nowMs) {
  return adjustForQuiet(nowMs + delayAfterMin(profile, stepSent) * MIN);
}

function fingerprint(title, startMs) {
  return String(title) + '|' + startMs;
}

function hashStr(s) {
  var h1 = 5381, h2 = 2166136261;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    h1 = ((h1 << 5) + h1 + c) | 0;
    h2 = Math.imul(h2 ^ c, 16777619) >>> 0;
  }
  return (h1 >>> 0).toString(36) + h2.toString(36);
}

function recordKey(eventId, startMs) {
  return 'e_' + hashStr(eventId + '|' + startMs);
}

function newRecord(cal, eventId, startMs, dueMs, fp) {
  return {
    cal: cal, eventId: eventId, startMs: startMs, dueMs: dueMs, fp: fp,
    step: 0, nextAt: dueMs, snoozeUntil: 0, pausedMs: 0, lastSentAt: 0,
    emailed: false, dropWarned: false, failCount: 0, failEmailed: false
  };
}

function isDue(rec, nowMs) {
  return nowMs >= rec.nextAt;
}

/** State after a successful send. */
function advance(rec, nowMs) {
  var r = Object.assign({}, rec);
  r.nextAt = nextAtAfterSend(rec.cal, rec.step, nowMs);
  r.step = rec.step + 1;
  r.lastSentAt = nowMs;
  r.failCount = 0;
  r.failEmailed = false;
  return r;
}

/** Snooze by m minutes; resumes at the same step. */
function applySnooze(rec, nowMs, m) {
  var r = Object.assign({}, rec);
  r.snoozeUntil = nowMs + m * MIN;
  r.nextAt = adjustForQuiet(r.snoozeUntil);
  r.pausedMs = (rec.pausedMs || 0) + m * MIN;
  return r;
}

/** Milliseconds of quiet hours inside [fromMs, toMs). */
function quietOverlapMs(fromMs, toMs) {
  if (toMs <= fromMs) return 0;
  var total = 0;
  var p = localParts(fromMs);
  for (var day = -1; ; day++) {
    var dayStart = localToMs(p.y, p.mo, p.d + day, 0, 0);
    if (dayStart > toMs) break;
    var segs = [
      [dayStart, localToMs(p.y, p.mo, p.d + day, QUIET_END.h, QUIET_END.m)],
      [localToMs(p.y, p.mo, p.d + day, QUIET_START.h, QUIET_START.m),
       localToMs(p.y, p.mo, p.d + day + 1, 0, 0)]
    ];
    for (var i = 0; i < segs.length; i++) {
      var a = Math.max(segs[i][0], fromMs), b = Math.min(segs[i][1], toMs);
      if (b > a) total += b - a;
    }
  }
  return total;
}

/** Time since due, minus snoozed time and quiet hours. */
function activeElapsedMs(dueMs, nowMs, pausedMs) {
  if (nowMs <= dueMs) return 0;
  return Math.max(0, nowMs - dueMs - quietOverlapMs(dueMs, nowMs) - (pausedMs || 0));
}

function shouldEmailUnanswered(rec, nowMs) {
  return !rec.emailed && activeElapsedMs(rec.dueMs, nowMs, rec.pausedMs) >= EMAIL_AFTER_MIN * MIN;
}

function shouldWarnDrop(rec, nowMs) {
  return !rec.dropWarned && nowMs - rec.dueMs >= (LOOKBACK_DAYS - 1) * DAY;
}

function isWorkingMinute(ms) {
  return Math.floor(ms / MIN) % 2 === 0;
}

function formatLocalHM(ms) {
  var p = localParts(ms);
  return (p.h < 10 ? '0' : '') + p.h + ':' + (p.mi < 10 ? '0' : '') + p.mi;
}

function dateKey(ms) {
  var p = localParts(ms);
  return p.y + '-' + p.mo + '-' + p.d;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PROFILES: PROFILES, parisOffsetMin: parisOffsetMin, localParts: localParts,
    localToMs: localToMs, inQuiet: inQuiet, quietEndFrom: quietEndFrom,
    adjustForQuiet: adjustForQuiet, dueMsFor: dueMsFor, priorityFor: priorityFor,
    delayAfterMin: delayAfterMin, nextAtAfterSend: nextAtAfterSend,
    fingerprint: fingerprint, recordKey: recordKey, newRecord: newRecord,
    isDue: isDue, advance: advance, applySnooze: applySnooze,
    quietOverlapMs: quietOverlapMs, activeElapsedMs: activeElapsedMs,
    shouldEmailUnanswered: shouldEmailUnanswered, shouldWarnDrop: shouldWarnDrop,
    isWorkingMinute: isWorkingMinute, formatLocalHM: formatLocalHM, dateKey: dateKey
  };
}

// ===================== Apps Script glue =====================

function prop_(k) {
  return PropertiesService.getScriptProperties().getProperty(k);
}

function setProp_(k, v) {
  PropertiesService.getScriptProperties().setProperty(k, v);
}

function loadRec_(key) {
  var s = prop_(key);
  return s ? JSON.parse(s) : null;
}

function saveRec_(key, rec) {
  setProp_(key, JSON.stringify(rec));
}

function requireProps_() {
  var missing = ['NTFY_TOPIC', 'SECRET', 'ALERT_EMAIL', 'WEBAPP_URL'].filter(function (k) { return !prop_(k); });
  if (missing.length) throw new Error('Missing script properties: ' + missing.join(', '));
}

/** Sends an email once per condition id; stays silent until clearAlert_ is called. */
function alertOnce_(id, subject, body) {
  var k = 'alert_' + id;
  if (prop_(k)) return;
  var to = prop_('ALERT_EMAIL');
  if (!to) { console.error('ALERT_EMAIL missing: ' + subject); return; }
  MailApp.sendEmail(to, '[Nag] ' + subject, body);
  setProp_(k, '1');
}

function clearAlert_(id) {
  PropertiesService.getScriptProperties().deleteProperty('alert_' + id);
}

/** Calendar for profile 'h' or 'n', looked up by name among owned calendars; ID cached. */
function getCal_(c) {
  var nameProp = c === 'h' ? 'CAL_HIGH' : 'CAL_NORMAL';
  var name = prop_(nameProp) || (c === 'h' ? CAL_HIGH_NAME : CAL_NORMAL_NAME);
  var idKey = 'calid_' + c;
  var cached = prop_(idKey);
  if (cached) {
    var cal = CalendarApp.getCalendarById(cached);
    if (cal) return cal;
  }
  var found = CalendarApp.getAllOwnedCalendars().filter(function (x) {
    return x.getName().toLowerCase() === name.toLowerCase();
  });
  if (!found.length) return null;
  setProp_(idKey, found[0].getId());
  return found[0];
}

function eventDue_(ev) {
  var start = ev.getStartTime().getTime();
  return { startMs: start, dueMs: dueMsFor(start, ev.isAllDayEvent()) };
}

function tick() {
  var now = Date.now();
  if (!isWorkingMinute(now)) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    runTick_(now, false);
  } catch (e) {
    console.error('tick failed: ' + e + '\n' + (e.stack || ''));
    throw e;
  } finally {
    lock.releaseLock();
  }
}

/** Logs what would be sent; sends nothing and changes no state. */
function dryRun() {
  runTick_(Date.now(), true);
}

function runTick_(now, dry) {
  requireProps_();
  ntfyFailedThisRun_ = false;
  var seen = {};        // record keys seen in successfully read calendars
  var okCals = {};      // calendars read successfully
  var open = [];
  var ctx = { sent: 0 };

  ['h', 'n'].forEach(function (c) {
    var cal = getCal_(c);
    if (!cal) {
      if (!dry) alertOnce_('nocal_' + c, 'Calendar missing: ' + PROFILES[c].label,
        'The calendar "' + PROFILES[c].label + '" was not found among your owned calendars. ' +
        'Set script property CAL_' + (c === 'h' ? 'HIGH' : 'NORMAL') + ' to its exact name.');
      console.error('calendar missing: ' + c);
      return;
    }
    if (!dry) clearAlert_('nocal_' + c);
    var events;
    try {
      events = cal.getEvents(new Date(now - LOOKBACK_DAYS * DAY), new Date(now + MIN));
    } catch (e) {
      console.error('read failed for ' + c + ': ' + e);   // trap: skip, do not treat as deleted
      return;
    }
    okCals[c] = true;
    events.forEach(function (ev) {
      var t = eventDue_(ev);
      if (t.dueMs > now || t.dueMs < now - LOOKBACK_DAYS * DAY) return;
      var id = ev.getId();
      var key = recordKey(id, t.startMs);
      seen[key] = true;
      var title = ev.getTitle() || 'Reminder';
      var fp = fingerprint(title, t.startMs);
      var rec = loadRec_(key);
      if (!rec || rec.fp !== fp) rec = newRecord(c, id, t.startMs, t.dueMs, fp);
      rec.title = title;
      handleEvent_(key, rec, now, dry, ctx);
      open.push({ key: key, rec: rec });
    });
  });

  if (dry) return;
  cleanupGone_(seen, okCals);
  heartbeat_(now);
  budgetCheck_(now, open);
}

function handleEvent_(key, rec, now, dry, ctx) {
  if (!dry) {
    if (shouldEmailUnanswered(rec, now)) {
      alertOnce_('unanswered_' + key, 'Unanswered reminder: ' + rec.title,
        rec.title + '\nCalendar: ' + PROFILES[rec.cal].label + '\nDue: ' + formatLocalHM(rec.dueMs) +
        '\nNo Done pressed after ' + EMAIL_AFTER_MIN + ' active minutes.');
      rec.emailed = true;
    }
    if (shouldWarnDrop(rec, now)) {
      alertOnce_('drop_' + key, 'Reminder will stop being nagged: ' + rec.title,
        rec.title + ' is almost ' + LOOKBACK_DAYS + ' days overdue and will stop being nagged tomorrow unless you move it.');
      rec.dropWarned = true;
    }
  }
  if (!isDue(rec, now)) {
    if (!dry) saveRec_(key, rec);
    return;
  }
  var overBudget = getCounter_(now) >= DAILY_SOFT_LIMIT && rec.step >= 2;
  if (overBudget) {
    if (!dry) saveRec_(key, rec);
    return;
  }
  if (dry) {
    console.log('WOULD SEND [' + PROFILES[rec.cal].label + '] "' + rec.title + '" step ' + rec.step +
      ' prio ' + priorityFor(rec.cal, rec.step) + ' due ' + formatLocalHM(rec.dueMs));
    return;
  }
  var ok = sendNag_(key, rec, now);
  if (ok) {
    incCounter_(now);
    rec = advance(rec, now);
  } else {
    rec.failCount = (rec.failCount || 0) + 1;
    if (rec.failCount >= SEND_FAIL_EMAIL_AFTER && !rec.failEmailed) {
      alertOnce_('sendfail', 'ntfy sending is failing', 'Sending to ntfy failed ' + rec.failCount + ' runs in a row for: ' + rec.title);
      rec.failEmailed = true;
    }
  }
  saveRec_(key, rec);
  if (ok) clearAlert_('sendfail');
}

function actionUrl_(a, rec, extra) {
  return prop_('WEBAPP_URL') + '?a=' + a + (extra || '') + '&c=' + rec.cal +
    '&e=' + encodeURIComponent(rec.eventId) + '&s=' + rec.startMs +
    '&k=' + encodeURIComponent(prop_('SECRET'));
}

var ntfyFailedThisRun_ = false;

/** One attempt per run. A hung connection costs ~50 s, so after one exception skip all further sends this run; the next run retries. */
function ntfyPost_(payload) {
  if (ntfyFailedThisRun_) return false;
  try {
    var res = UrlFetchApp.fetch(NTFY_URL, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify(payload), muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code >= 200 && code < 300) return true;
    console.error('ntfy rejected: HTTP ' + code + ' ' + res.getContentText());
  } catch (e) {
    ntfyFailedThisRun_ = true;
    console.error('ntfy send failed: ' + e);
  }
  return false;
}

function buildPayload_(key, rec) {
  var step = rec.step;
  return {
    topic: prop_('NTFY_TOPIC'),
    sequence_id: key,
    title: rec.title,
    message: PROFILES[rec.cal].label + ' · due ' + formatLocalHM(rec.dueMs) + ' · reminder ' + (step + 1),
    priority: priorityFor(rec.cal, step),
    tags: ['alarm_clock'],
    actions: [
      { action: 'http', label: 'Done', url: actionUrl_('done', rec), method: 'POST', clear: true },
      { action: 'http', label: '+30 min', url: actionUrl_('snooze', rec, '&m=30'), method: 'POST', clear: true },
      { action: 'http', label: '+2 h', url: actionUrl_('snooze', rec, '&m=120'), method: 'POST', clear: true }
    ]
  };
}

function sendNag_(key, rec, now) {
  try {
    return ntfyPost_(buildPayload_(key, rec));
  } catch (e) {
    console.error('ntfy send failed: ' + e);
    return false;
  }
}

/** Records whose event is gone (read succeeded, event absent): drop record, clear notification. */
function cleanupGone_(seen, okCals) {
  var all = PropertiesService.getScriptProperties().getProperties();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('e_') !== 0 || seen[k]) return;
    var rec = JSON.parse(all[k]);
    if (!okCals[rec.cal]) return;
    clearNotification_(k);
    PropertiesService.getScriptProperties().deleteProperty(k);
    clearAlert_('unanswered_' + k);
    clearAlert_('drop_' + k);
  });
}

function clearNotification_(key) {
  try {
    UrlFetchApp.fetch(NTFY_URL + encodeURIComponent(prop_('NTFY_TOPIC')) + '/' + encodeURIComponent(key) + '/clear',
      { method: 'put', muteHttpExceptions: true });
  } catch (e) {
    console.error('clear failed: ' + e);
  }
}

function getCounter_(now) {
  var s = prop_('counter');
  if (!s) return 0;
  var c = JSON.parse(s);
  return c.day === dateKey(now) ? c.n : 0;
}

function incCounter_(now) {
  setProp_('counter', JSON.stringify({ day: dateKey(now), n: getCounter_(now) + 1 }));
}

function budgetCheck_(now, open) {
  if (getCounter_(now) < DAILY_SOFT_LIMIT) return;
  alertOnce_('budget_' + dateKey(now), 'Daily message budget reached',
    'Repeats are paused for today. Open reminders:\n' +
    open.map(function (o) { return '- ' + o.rec.title + ' (' + PROFILES[o.rec.cal].label + ')'; }).join('\n'));
}

/** Once an hour: (re)schedule the "stopped running" message 3 hours ahead. */
function heartbeat_(now) {
  var last = Number(prop_('heartbeatAt') || 0);
  if (now - last < 60 * MIN) return;
  var ok = ntfyPost_({
    topic: prop_('NTFY_TOPIC'), sequence_id: 'deadman', delay: DEADMAN_DELAY,
    title: 'Nag system has stopped running',
    message: 'No tick for ' + DEADMAN_DELAY + '. Check the Apps Script trigger.',
    priority: 5, tags: ['warning']
  });
  if (ok) setProp_('heartbeatAt', String(now));
}

// ===================== Web app =====================

function doPost(e) { return handle_(e); }
function doGet(e) { return handle_(e); }

function out_(s) {
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.TEXT);
}

function handle_(e) {
  var p = (e && e.parameter) || {};
  var secret = prop_('SECRET');
  if (!secret || p.k !== secret) return out_('denied');
  if ((p.c !== 'h' && p.c !== 'n') || !p.e || !p.s) return out_('bad request');
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return out_('busy');
  try {
    var startMs = Number(p.s);
    var key = recordKey(p.e, startMs);
    if (p.a === 'done') {
      var cal = getCal_(p.c);
      if (cal) {
        var evs = cal.getEvents(new Date(startMs - MIN), new Date(startMs + MIN));
        for (var i = 0; i < evs.length; i++) {
          if (evs[i].getId() === p.e && evs[i].getStartTime().getTime() === startMs) {
            evs[i].deleteEvent();   // this occurrence object, not the series
            break;
          }
        }
      }
      PropertiesService.getScriptProperties().deleteProperty(key);
      clearNotification_(key);   // do not rely on the app's clear:true if it reports an error
      return out_('ok');
    }
    if (p.a === 'snooze') {
      var m = Number(p.m);
      if (!(m > 0 && m <= 24 * 60)) return out_('bad request');
      var rec = loadRec_(key);
      if (!rec) return out_('ok');
      saveRec_(key, applySnooze(rec, Date.now(), m));
      clearNotification_(key);
      return out_('ok');
    }
    return out_('bad request');
  } finally {
    lock.releaseLock();
  }
}

// ===================== Setup and test =====================

/** Run once: creates the 1-minute trigger and resolves calendars. */
function setup() {
  requireProps_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'tick') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(1).create();
  var props = PropertiesService.getScriptProperties();
  ['calid_h', 'calid_n', 'heartbeatAt'].forEach(function (k) { props.deleteProperty(k); });
  ['h', 'n'].forEach(function (c) {
    var cal = getCal_(c);
    console.log(PROFILES[c].label + ': ' + (cal ? 'found "' + cal.getName() + '"' : 'NOT FOUND'));
  });
  console.log('Trigger created. Now set the trigger failure notifications to "Notify me immediately".');
}

/** Sends one test notification with working buttons (creates a throwaway test event). */
function sendTestNag() {
  requireProps_();
  var cal = getCal_('n');
  if (!cal) throw new Error('Normal calendar not found');
  var start = new Date(Date.now() - 2 * MIN);
  var ev = cal.createEvent('Test nag', start, new Date(start.getTime() + 15 * MIN));
  var startMs = ev.getStartTime().getTime();
  var rec = newRecord('n', ev.getId(), startMs, startMs, fingerprint('Test nag', startMs));
  rec.title = 'Test nag';
  var key = recordKey(rec.eventId, startMs);
  if (!sendNag_(key, rec, Date.now())) throw new Error('ntfy send failed');
  console.log('Test nag sent. Event created in the Normal calendar; Done deletes it.');
}

/** Diagnostic: can Apps Script reach ntfy.sh at all? Run from the editor and read the log. */
function pingNtfy() {
  ['https://ntfy.sh/v1/health', 'https://www.google.com/'].forEach(function (u) {
    try {
      var r = UrlFetchApp.fetch(u, { muteHttpExceptions: true });
      console.log(u + ' -> HTTP ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 80));
    } catch (e) {
      console.log(u + ' -> ' + e);
    }
  });
}

/** Diagnostic: tries several ways of publishing to ntfy and logs each result. */
function testPublish() {
  var topic = prop_('NTFY_TOPIC');
  var tries = [
    ['root JSON, trailing slash', 'https://ntfy.sh/', { contentType: 'application/json', payload: JSON.stringify({ topic: topic, message: 'test 1 (root JSON)' }) }],
    ['root JSON, no slash', 'https://ntfy.sh', { contentType: 'application/json', payload: JSON.stringify({ topic: topic, message: 'test 2 (root JSON no slash)' }) }],
    ['topic URL, plain text', 'https://ntfy.sh/' + encodeURIComponent(topic), { contentType: 'text/plain', payload: 'test 3 (topic URL)' }]
  ];
  tries.forEach(function (t) {
    try {
      var opts = { method: 'post', muteHttpExceptions: true, contentType: t[2].contentType, payload: t[2].payload };
      var r = UrlFetchApp.fetch(t[1], opts);
      console.log(t[0] + ' -> HTTP ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 100));
    } catch (e) {
      console.log(t[0] + ' -> ' + e);
    }
  });
}
