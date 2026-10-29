/**
 * 水上俱乐部 · 记录备份云函数
 * 作用：保管飞书凭据，接收网页的备份请求，写入飞书多维表格
 * 部署：腾讯云 CloudBase 云函数（Node.js 16+），见 docs/部署指引-飞书备份.md
 *
 * 环境变量（全部必配，除 ADMIN_TOKEN_HASH 外）：
 *   FEISHU_APP_ID       飞书自建应用 App ID
 *   FEISHU_APP_SECRET   飞书自建应用 App Secret
 *   FEISHU_APP_TOKEN    多维表格的 app_token（表格 URL 里 base/ 后面的那串）
 *   TABLE_SESSIONS      场次表 table_id
 *   TABLE_RECORDS       积分记录表 table_id
 *   TABLE_DEVICES       设备表 table_id
 *   TEAM_TOKEN_HASH     团队口令的 SHA-256（十六进制小写）
 *   ADMIN_TOKEN_HASH    管理员口令的 SHA-256（选填，不配就没有管理员）
 *   MAX_PER_MINUTE      单设备每分钟最大请求数（默认 30）
 */

'use strict';

const crypto = require('crypto');

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';

// ==================== 配置 ====================
function env(name, def) {
    const v = process.env[name];
    return (v === undefined || v === null || v === '') ? (def === undefined ? '' : def) : String(v);
}

function config() {
    return {
        appId: env('FEISHU_APP_ID'),
        appSecret: env('FEISHU_APP_SECRET'),
        appToken: env('FEISHU_APP_TOKEN'),
        tableSessions: env('TABLE_SESSIONS'),
        tableRecords: env('TABLE_RECORDS'),
        tableDevices: env('TABLE_DEVICES'),
        teamHash: (env('TEAM_TOKEN_HASH') || '').toLowerCase(),
        adminHash: (env('ADMIN_TOKEN_HASH') || '').toLowerCase(),
        maxPerMinute: parseInt(env('MAX_PER_MINUTE', '30'), 10) || 30
    };
}

// ==================== 飞书 API ====================
let tokenCache = { token: '', expireAt: 0 };

async function getTenantToken(cfg) {
    const now = Date.now();
    if (tokenCache.token && now < tokenCache.expireAt) {
        return tokenCache.token;
    }
    const res = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret })
    });
    const data = await res.json();
    if (data.code !== 0 || !data.tenant_access_token) {
        throw new Error(`获取飞书令牌失败：${data.msg || '未知错误'}`);
    }
    tokenCache = {
        token: data.tenant_access_token,
        expireAt: now + (parseInt(data.expire, 10) - 120) * 1000
    };
    return tokenCache.token;
}

async function feishuGet(path, cfg) {
    const token = await getTenantToken(cfg);
    const res = await fetch(`${FEISHU_BASE}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.code !== 0) {
        throw new Error(`飞书接口错误：${data.msg || data.code}`);
    }
    return data.data;
}

async function feishuSend(path, method, body, cfg) {
    const token = await getTenantToken(cfg);
    const res = await fetch(`${FEISHU_BASE}${path}`, {
        method: method,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify(body)
    });
    const data = await res.json();
    if (data.code !== 0) {
        throw new Error(`飞书接口错误：${data.msg || data.code}`);
    }
    return data.data;
}

/** 拉取整张表的全部记录（自动翻页），小数据量足够 */
async function listRecords(tableId, cfg) {
    const items = [];
    let pageToken = '';
    for (let i = 0; i < 20; i++) {
        let path = `/bitable/v1/apps/${cfg.appToken}/tables/${tableId}/records?page_size=500`;
        if (pageToken) { path += `&page_token=${encodeURIComponent(pageToken)}`; }
        const data = await feishuGet(path, cfg);
        if (data && data.items) {
            for (const it of data.items) { items.push(it); }
        }
        if (data && data.has_more && data.page_token) {
            pageToken = data.page_token;
        } else {
            break;
        }
    }
    return items;
}

/** 按唯一键 upsert：存在则更新，不存在则新增 */
async function upsert(tableId, uniqueKey, fields, cfg) {
    const records = await listRecords(tableId, cfg);
    let hit = null;
    for (const r of records) {
        const f = r.fields || {};
        if (String(f[uniqueKey] || '') === String(fields[uniqueKey] || '')) {
            hit = r;
            break;
        }
    }
    if (hit) {
        await feishuSend(
            `/bitable/v1/apps/${cfg.appToken}/tables/${tableId}/records/${hit.record_id}`,
            'PUT',
            { fields },
            cfg
        );
        return 'updated';
    }
    await feishuSend(
        `/bitable/v1/apps/${cfg.appToken}/tables/${tableId}/records`,
        'POST',
        { fields },
        cfg
    );
    return 'created';
}

// ==================== 工具 ====================
/** 定长比较，避免时序侧信道 */
function safeEqual(a, b) {
    const x = String(a || '').toLowerCase();
    const y = String(b || '').toLowerCase();
    if (x.length !== y.length) { return false; }
    try {
        return crypto.timingSafeEqual(Buffer.from(x), Buffer.from(y));
    } catch (e) {
        let diff = 0;
        for (let i = 0; i < x.length; i++) { diff |= x.charCodeAt(i) ^ y.charCodeAt(i); }
        return diff === 0;
    }
}

function sanitizeText(v, maxLen) {
    let s = String(v === undefined || v === null ? '' : v).trim();
    if (s.length > maxLen) { s = s.slice(0, maxLen); }
    // 防止被表格当成公式执行
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

/** 限流：按 deviceId 统计每分钟请求数 */
const rateMap = new Map();
function rateLimited(deviceId, limit) {
    const now = Date.now();
    const key = String(deviceId || 'anon');
    let rec = rateMap.get(key);
    if (!rec || now - rec.start > 60000) {
        rec = { start: now, count: 0 };
        rateMap.set(key, rec);
    }
    rec.count++;
    // 清理过期项，避免内存无限增长
    if (rateMap.size > 2000) {
        for (const [k, v] of rateMap.entries()) {
            if (now - v.start > 600000) { rateMap.delete(k); }
        }
    }
    return rec.count > limit;
}

/** 设备是否被停用（读设备表，缓存 60 秒） */
let deviceCache = { at: 0, disabled: {} };
async function isDeviceDisabled(deviceId, cfg) {
    const now = Date.now();
    if (now - deviceCache.at > 60000) {
        const map = {};
        try {
            const rows = await listRecords(cfg.tableDevices, cfg);
            for (const r of rows) {
                const f = r.fields || {};
                const id = String(f['设备码'] || '');
                if (!id) { continue; }
                const status = String(f['状态'] || '正常');
                if (status === '停用') { map[id] = true; }
            }
        } catch (e) {
            // 读不到设备表时不阻断（保守：允许写入，仅记录日志）
            console.log('读取设备表失败：' + e.message);
        }
        deviceCache = { at: now, disabled: map };
    }
    return !!deviceCache.disabled[String(deviceId || '')];
}

// ==================== 业务处理 ====================
function ok(data) {
    return { ok: true, ...(data || {}) };
}
function fail(code, message) {
    return { ok: false, code: code, message: message };
}

/** 绑定：校验团队口令（+ 管理员口令） */
function handleBind(body, cfg) {
    const tokenHash = String(body.tokenHash || '').toLowerCase();
    if (!cfg.teamHash) {
        return fail('SERVER_NOT_CONFIGURED', '云函数未配置团队口令，请联系管理员');
    }
    if (!safeEqual(tokenHash, cfg.teamHash)) {
        return fail('TOKEN_INVALID', '访问口令有误');
    }
    // 管理员口令：正确则管理员，错误则静默降级为普通用户（不暴露管理员账号存在）
    let role = 'user';
    const adminHash = String(body.adminHash || '').toLowerCase();
    if (adminHash && cfg.adminHash && safeEqual(adminHash, cfg.adminHash)) {
        role = 'admin';
    }
    return ok({ role: role });
}

/** 备份：写入场次与积分记录 */
async function handleSync(body, cfg) {
    const tokenHash = String(body.tokenHash || '').toLowerCase();
    if (!cfg.teamHash || !safeEqual(tokenHash, cfg.teamHash)) {
        return fail('TOKEN_INVALID', '访问口令有误');
    }
    const deviceId = sanitizeText(body.deviceId, 64);
    if (!deviceId) {
        return fail('BAD_REQUEST', '缺少设备标识');
    }
    if (rateLimited(deviceId, cfg.maxPerMinute)) {
        return fail('RATE_LIMIT', '操作过于频繁，请稍后再试');
    }
    if (await isDeviceDisabled(deviceId, cfg)) {
        return fail('DEVICE_DISABLED', '该设备已被停用，请联系管理员');
    }

    const items = Array.isArray(body.items) ? body.items.slice(0, 50) : [];
    if (!items.length) {
        return ok({ count: 0 });
    }

    let created = 0, updated = 0, skipped = 0;
    for (const item of items) {
        try {
            const sess = item.session || {};
            const date = sanitizeText(sess.date, 20);
            const sessionName = sanitizeText(sess.sessionName, 30);
            const table = sanitizeText(sess.table, 10);
            const expected = toInt(sess.expected, 1, 30, 10);

            if (!date || !table) {
                skipped++;
                continue;
            }
            const sessionId = `${date}-${sessionName}-${table}`;

            // ① 场次行
            const sFields = {
                '场次ID': sessionId,
                '日期': date,
                '场次': sessionName,
                '桌号': table,
                '应到人数': expected,
                '记录人': sanitizeText(sess.recorder, 20),
                '审核人': sanitizeText(sess.reviewer, 20),
                '评分': sanitizeText(sess.rating, 20),
                '来源设备': deviceId,
                '更新时间': new Date().toISOString()
            };
            const sRes = await upsert(cfg.tableSessions, '场次ID', sFields, cfg);
            if (sRes === 'created') { created++; } else { updated++; }

            // ② 积分记录行
            if (item.type === 'record' && item.row) {
                const r = item.row;
                const name = sanitizeText(r.name, 12);
                if (!name) {
                    skipped++;
                    continue;
                }
                const total = toInt(r.total, 0, 99999999, 0);
                const points = toInt(r.points, -9999, 99999, 0);
                const pay = toInt(r.pay, 0, 999999, 0);
                const rFields = {
                    '记录键': sessionId + '|' + name,
                    '昵称': name,
                    '场次ID': sessionId,
                    '日期': date,
                    '场次': sessionName,
                    '桌号': table,
                    '桌面筹码': toInt(r.chips, 0, 99999999, 0),
                    '剩余黄卡': toInt(r.cards, 0, 7, 0),
                    '总码量': total,
                    '本场积分': points,
                    '需支付': pay,
                    '欠卡数': toInt(r.cardGap, 0, 7, 0),
                    '来源设备': deviceId,
                    '更新时间': new Date().toISOString()
                };
                const rRes = await upsert(cfg.tableRecords, '记录键', rFields, cfg);
                if (rRes === 'created') { created++; } else { updated++; }
            }
        } catch (e) {
            console.log('写入失败：' + e.message);
            skipped++;
        }
    }
    return ok({ count: created + updated, created: created, updated: updated, skipped: skipped });
}

// ==================== 入口 ====================
exports.main = async (event, context) => {
    const cfg = config();
    if (!cfg.appId || !cfg.appSecret || !cfg.appToken) {
        return fail('SERVER_NOT_CONFIGURED', '云函数环境变量未配置完整');
    }
    let body = {};
    try {
        body = typeof event.body === 'string' ? JSON.parse(event.body || '{}') : (event.body || {});
    } catch (e) {
        return fail('BAD_REQUEST', '请求格式错误');
    }
    const action = String(body.action || '');

    try {
        if (action === 'bind') {
            return handleBind(body, cfg);
        }
        if (action === 'sync') {
            return await handleSync(body, cfg);
        }
        return fail('BAD_REQUEST', '未知操作');
    } catch (e) {
        console.log('云函数异常：' + (e && e.message ? e.message : e));
        return fail('SERVER_ERROR', '服务暂时不可用，请稍后重试');
    }
};
