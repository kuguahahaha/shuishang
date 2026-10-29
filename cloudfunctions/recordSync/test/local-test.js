/**
 * 云函数本地自测（不需要飞书账号）
 * 覆盖：口令校验、管理员口令错误静默降级、字段校验、限流、非法输入处理
 * 运行：node cloudfunctions/recordSync/test/local-test.js
 */
'use strict';

const crypto = require('crypto');
const path = require('path');

// 复刻 index.js 里的关键逻辑（不依赖飞书网络调用）
function sha256(s) {
    return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}
function safeEqual(a, b) {
    const x = String(a || '').toLowerCase();
    const y = String(b || '').toLowerCase();
    if (x.length !== y.length) { return false; }
    try { return crypto.timingSafeEqual(Buffer.from(x), Buffer.from(y)); } catch (e) { return x === y; }
}
function sanitizeText(v, maxLen) {
    let s = String(v === undefined || v === null ? '' : v).trim();
    if (s.length > maxLen) { s = s.slice(0, maxLen); }
    if (/^[=+\-@]/.test(s)) { s = "'" + s; }
    return s;
}
function toInt(v, min, max, def) {
    const n = parseInt(v, 10);
    if (isNaN(n)) { return def; }
    if (n < min) { return min; }
    if (n > max) { return max; }
    return n;
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log('  ✅ ' + name); }
    else { fail++; console.log('  ❌ ' + name + (extra ? ' → ' + extra : '')); }
}

console.log('=== 水上俱乐部 · 云函数本地自测 ===\n');

console.log('[1] 口令哈希与比对');
const TEAM = 'WaterClub@2026';
const ADMIN = 'AdminSecret#9';
const teamHash = sha256(TEAM);
const adminHash = sha256(ADMIN);
check('SHA-256 长度 64', teamHash.length === 64, teamHash);
check('SHA-256 与标准值一致', sha256('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
check('正确口令比对通过', safeEqual(sha256(TEAM), teamHash));
check('错误口令比对拒绝', !safeEqual(sha256('wrong'), teamHash));
check('大小写不敏感（统一转小写后比对）', safeEqual(teamHash.toUpperCase(), teamHash));
check('长度不同直接拒绝', !safeEqual('abc', 'abcd'));

console.log('\n[2] 角色判定（管理员口令错误 → 静默降级）');
function decideRole(userHash, admHash, cfgTeam, cfgAdmin) {
    if (!cfgTeam || !safeEqual(userHash, cfgTeam)) { return { ok: false, code: 'TOKEN_INVALID' }; }
    let role = 'user';
    if (admHash && cfgAdmin && safeEqual(admHash, cfgAdmin)) { role = 'admin'; }
    return { ok: true, role: role };
}
let r = decideRole(teamHash, adminHash, teamHash, adminHash);
check('团队口令 + 管理员口令正确 → 管理员', r.ok && r.role === 'admin');
r = decideRole(teamHash, '', teamHash, adminHash);
check('只给团队口令 → 普通用户', r.ok && r.role === 'user');
r = decideRole(teamHash, sha256('wrong-admin'), teamHash, adminHash);
check('管理员口令错误 → 静默降级为普通用户（不报错）', r.ok && r.role === 'user');
r = decideRole(sha256('wrong'), '', teamHash, adminHash);
check('团队口令错误 → 拒绝', !r.ok && r.code === 'TOKEN_INVALID');

console.log('\n[3] 字段清洗与校验');
check('昵称超长截断', sanitizeText('ABCDEFGHIJKLMNOP', 12).length === 12);
check('公式注入前缀处理', sanitizeText('=cmd|calc', 20).charAt(0) === "'");
check('@ 开头也被转义', sanitizeText('@sum(A1)', 20).charAt(0) === "'");
check('负号开头被转义', sanitizeText('-1+1', 20).charAt(0) === "'");
check('数值下限钳制', toInt(-5, 0, 100, 10) === 0);
check('数值上限钳制', toInt(999, 0, 100, 10) === 100);
check('非数字用默认值', toInt('abc', 0, 100, 10) === 10);
check('黄卡张数钳制在 0~7', toInt(99, 0, 7, 0) === 7);

console.log('\n[4] 唯一键（幂等去重）');
const sess = { date: '2026-10-29', sessionName: '下午场', table: 'A' };
const sessionId = `${sess.date}-${sess.sessionName}-${sess.table}`;
const recordKey = sessionId + '|' + 'captain';
check('场次ID 格式正确', sessionId === '2026-10-29-下午场-A', sessionId);
check('记录键包含昵称', recordKey === '2026-10-29-下午场-A|captain', recordKey);
check('同键视为同一条（幂等）', recordKey === `${sess.date}-${sess.sessionName}-${sess.table}|captain`);

console.log('\n[5] 限流');
const rateMap = new Map();
function rateLimited(deviceId, limit) {
    const now = Date.now();
    let rec = rateMap.get(deviceId);
    if (!rec || now - rec.start > 60000) { rec = { start: now, count: 0 }; rateMap.set(deviceId, rec); }
    rec.count++;
    return rec.count > limit;
}
let hit = false;
for (let i = 0; i < 31; i++) { if (rateLimited('dev-a', 30)) { hit = true; } }
check('第 31 次请求被限流', hit);
let earlyHit = false;
const rateMap2 = new Map();
function rateLimited2(id, limit) {
    const now = Date.now();
    let rec = rateMap2.get(id);
    if (!rec || now - rec.start > 60000) { rec = { start: now, count: 0 }; rateMap2.set(id, rec); }
    rec.count++;
    return rec.count > limit;
}
for (let i = 0; i < 30; i++) { if (rateLimited2('dev-c', 30)) { earlyHit = true; } }
check('前 30 次请求不触发限流', !earlyHit);
check('不同设备独立计数', !rateLimited('dev-b', 30));

console.log('\n[6] 纸表数据写入前的字段准备（与网页端一致）');
const row = { name: 'captain', chips: 0, cards: 0, total: 0, cardGap: 7, pay: 70, points: -68 };
const fields = {
    '记录键': recordKey,
    '昵称': sanitizeText(row.name, 12),
    '总码量': toInt(row.total, 0, 99999999, 0),
    '本场积分': toInt(row.points, -9999, 99999, 0),
    '需支付': toInt(row.pay, 0, 999999, 0),
    '欠卡数': toInt(row.cardGap, 0, 7, 0)
};
check('负积分可写入（-68 不被钳制）', fields['本场积分'] === -68, fields['本场积分']);
check('欠卡数 7 合法', fields['欠卡数'] === 7);

console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
if (fail > 0) { process.exit(1); }
console.log('提示：口令哈希可在本地用 node -e "console.log(require(\'crypto\').createHash(\'sha256\').update(\'你的口令\').digest(\'hex\'))" 生成');
