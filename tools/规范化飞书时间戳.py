#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
飞书表时间戳格式规范化脚本（幂等，可反复运行）

把形如 2026-11-01T14:47:14.557Z 的 ISO 时间
统一转成 2026-11-01 14:47:14.557（空格分隔，去掉 T 和 Z）

★ 保持 UTC 数值不变（只是换分隔符），与云函数 nowStamp() 的 getUTC* 基准一致。

★ 安全：App ID / App Secret 从环境变量读取，**不写进仓库**
  用法（Windows Git Bash）：
      export FEISHU_APP_ID='cli_xxxxx'
      export FEISHU_APP_SECRET='你的secret'
      python tools/规范化飞书时间戳.py
  或在系统环境变量里配置好再运行。
"""
import json
import os
import ssl
import sys
import urllib.request

APP_ID = os.environ.get('FEISHU_APP_ID', '')
APP_SECRET = os.environ.get('FEISHU_APP_SECRET', '')
APP_TOKEN = os.environ.get('FEISHU_APP_TOKEN', '')

# ★ 表 ID 不写进仓库（和云函数保持一致，全部从环境变量读）
TABLES = [
    ('场次表', os.environ.get('TABLE_SESSIONS', ''), ['更新时间']),
    ('积分记录表', os.environ.get('TABLE_RECORDS', ''), ['更新时间']),
    ('设备表', os.environ.get('TABLE_DEVICES', ''), ['首次出现', '最近出现']),
]

BASE = 'https://open.feishu.cn/open-apis'
CTX = ssl.create_default_context()


def call(method, path, body=None, token=None):
    url = BASE + path
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Content-Type', 'application/json; charset=utf-8')
    if token:
        req.add_header('Authorization', 'Bearer ' + token)
    with urllib.request.urlopen(req, timeout=30, context=CTX) as r:
        return json.loads(r.read().decode('utf-8'))


def field_text(v):
    """飞书字段值可能是 [{text,type}] 数组 / 对象 / 原始值"""
    if v is None:
        return ''
    if isinstance(v, list):
        out = ''
        for x in v:
            if isinstance(x, dict):
                out += str(x.get('text', x.get('name', x.get('value', ''))))
            else:
                out += str(x)
        return out
    if isinstance(v, dict):
        return str(v.get('text', v.get('name', v.get('value', ''))))
    return str(v)


def convert(s):
    """ISO → 空格分隔；已是新格式则原样返回；其他返回 None"""
    if not s:
        return None
    s = str(s).strip()
    # 2026-11-01T14:47:14.557Z  →  2026-11-01 14:47:14.557
    if len(s) >= 23 and s[4] == '-' and s[10] == 'T':
        return s[:10] + ' ' + s[11:23]
    # 已经是 2026-11-01 14:47:14.557
    if len(s) >= 23 and s[4] == '-' and s[10] == ' ':
        return s[:23]
    return None


def main():
    if not APP_ID or not APP_SECRET or not APP_TOKEN or not all(t[1] for t in TABLES):
        print('缺少配置：请先设置环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET / '
              'FEISHU_APP_TOKEN / TABLE_SESSIONS / TABLE_RECORDS / TABLE_DEVICES')
        print('  export FEISHU_APP_ID=...')
        print('  export FEISHU_APP_SECRET=...')
        sys.exit(1)

    tk = call('POST', '/auth/v3/tenant_access_token/internal',
              {'app_id': APP_ID, 'app_secret': APP_SECRET})
    if tk.get('code') != 0:
        print('取 token 失败：%s %s' % (tk.get('code'), tk.get('msg')))
        sys.exit(1)
    token = tk['tenant_access_token']

    total_fixed = 0
    for name, tid, fields in TABLES:
        rows = call('GET', '/bitable/v1/apps/%s/tables/%s/records?page_size=500'
                    % (APP_TOKEN, tid), None, token)
        items = (rows.get('data') or {}).get('items') or []

        upd = []
        for it in items:
            f = {}
            changed = False
            for k in fields:
                old = field_text((it.get('fields') or {}).get(k))
                new = convert(old)
                if new and new != old:
                    f[k] = new
                    changed = True
            if changed:
                upd.append({'record_id': it['record_id'], 'fields': f})

        if not upd:
            print('[%s] %d 行 — 全部已是新格式 ✓' % (name, len(items)))
            continue

        r = call('POST', '/bitable/v1/apps/%s/tables/%s/records/batch_update'
                 % (APP_TOKEN, tid), {'records': upd}, token)
        ok = r.get('code') == 0
        total_fixed += len(upd) if ok else 0
        print('[%s] %d 行 → 转换 %d 行  code=%s %s'
              % (name, len(items), len(upd), r.get('code'), r.get('msg') or ''))

    print('')
    print('共转换 %d 行' % total_fixed)

    # 复核
    print('')
    print('=== 复核 ===')
    for name, tid, fields in TABLES:
        rows = call('GET', '/bitable/v1/apps/%s/tables/%s/records?page_size=500'
                    % (APP_TOKEN, tid), None, token)
        items = (rows.get('data') or {}).get('items') or []
        bad = 0
        for it in items:
            for k in fields:
                v = field_text((it.get('fields') or {}).get(k))
                if v and 'T' in v[:12]:
                    bad += 1
        sample = ''
        if items:
            sample = field_text((items[0].get('fields') or {}).get(fields[0]))
        print('  [%s] %d 行 | 残留ISO %d | 样例 %s'
              % (name, len(items), bad, sample or '(空)'))


if __name__ == '__main__':
    main()
