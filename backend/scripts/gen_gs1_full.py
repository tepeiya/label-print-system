#!/usr/bin/env python3
"""
gen_gs1_full.py —— 从 GS1 官方 JSON-LD 重新生成 core/gs1-ai.full.ts（第三层 · 码制专业性）

用法：
    python3 scripts/gen_gs1_full.py                 # 从官方 URL 下载
    python3 scripts/gen_gs1_full.py /path/to.jsonld # 用本地 JSON-LD（离线）

数据源：https://ref.gs1.org/ai/GS1_Application_Identifiers.jsonld
生成后请跑：cd backend && npm run typecheck && node --import tsx --test core/__tests__/gs1-ai.test.ts

诚实边界：长度/字符集从 formatString 的第一个数据组件推导，复合格式（如 N13[+X..17]）
取首段；中文精调字段以 core/gs1-ai.ts 的 AI_LIST 为准并优先命中。
"""
import json
import os
import re
import sys
import urllib.request

WORKDIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # backend/
OUT = os.path.join(WORKDIR, 'core', 'gs1-ai.full.ts')
URL = 'https://ref.gs1.org/ai/GS1_Application_Identifiers.jsonld'


def load_jsonld() -> dict:
    if len(sys.argv) > 1:
        with open(sys.argv[1], encoding='utf-8') as f:
            return json.load(f)
    with urllib.request.urlopen(URL, timeout=120) as r:
        return json.loads(r.read().decode('utf-8'))


def esc(s) -> str:
    return str(s).replace('\\', '\\\\').replace("'", "\\'").replace('\n', ' ').replace('\r', '')


def kind_of(c: dict, ai: str) -> str:
    t = c.get('type', 'N')
    if t in ('X', 'Y'):
        return 'alphanumeric'
    if c.get('checkDigit'):
        if ai in ('00', '8017', '8018'):
            return 'sscc'
        if ai in ('410', '411', '412', '413', '414', '415', '416', '417'):
            return 'gln'
        if ai in ('253', '255'):
            return 'alphanumeric'
        return 'gtin'
    return 'numeric'


def group_of(title: str) -> str:
    t = title.lower()
    if any(k in t for k in ('date', 'expir', 'best before', 'sell by', 'production')):
        return '日期'
    if any(k in t for k in ('weight', 'length', 'width', 'height', 'volume', 'area',
                            'amount', 'price', 'net ', 'gross', 'quantity', 'count')):
        return '数量金额'
    if any(k in t for k in ('sscc', 'shipment', 'logistic', 'packing', 'route', 'ship',
                            'postal', 'country')):
        return '物流'
    if any(k in t for k in ('batch', 'lot', 'serial', 'trace', 'slaughter')):
        return '追溯'
    if any(k in t for k in ('internal', 'company', 'coupon', 'url', 'reference')):
        return '内部'
    return '标识'


HEADER = """// =============================================================================
// gs1-ai.full.ts —— GS1 应用标识符全量字典（第三层 · 码制专业性）
//
// 【数据来源】GS1 官方 Application Identifiers 数据集（JSON-LD）：
//   https://ref.gs1.org/ai/GS1_Application_Identifiers.jsonld
//   由 scripts/gen_gs1_full.py 从 formatString / components 推导长度与字符集。
//
// 【诚实声明】本文件是 GS1 官方数据派生的全量索引；中文精调字段（示例/行业分组）
//   仍以 gs1-ai.ts 的 AI_LIST 为准并优先命中。长度按 formatString 主数据组件推导，
//   复合格式（如 N13[+X..17]）取第一段；行业专用码请以最新 GS1 General
//   Specifications 官方手册复核。未登记 AI 仍按宽松处理 + warning。
//
// 【单一真源】本字典由 gs1-ai.ts 的 lookupAi 派生使用，不单独对外暴露判定逻辑。
//   由脚本生成，请勿手工编辑（重生：python3 scripts/gen_gs1_full.py）。
// =============================================================================

import type { Gs1Ai } from './gs1-ai';

const FULL_AI_LIST: Gs1Ai[] = [
"""


def main() -> None:
    data = load_jsonld()
    graph = data.get('applicationIdentifiers', [])
    ais = [e for e in graph
           if isinstance(e, dict) and re.fullmatch(r'\d{2,4}', str(e.get('applicationIdentifier', '')))]
    ais.sort(key=lambda a: (len(a['applicationIdentifier']), a['applicationIdentifier']))

    rows = []
    for a in ais:
        ai = a['applicationIdentifier']
        title = a.get('description') or a.get('title') or ai
        comps = a.get('components', [])
        # 第一个非 key 组件是主数据组件；key 组件表示 AI 前缀本身
        dc = next((c for c in comps if not c.get('key')), comps[0] if comps else {})
        fixed = dc.get('length') if dc.get('fixedLength') else None
        maxlen = None if fixed else dc.get('length')
        parts = [f"ai: '{ai}'", f"title: '{esc(title)}'",
                 f"group: '{group_of(title)}'", f"kind: '{kind_of(dc, ai)}'"]
        if fixed:
            parts.append(f"fixedLen: {fixed}")
        elif maxlen:
            parts.extend([f"maxLen: {maxlen}", "minLen: 1"])
        if any(c.get('checkDigit') for c in comps):
            parts.append("checkDigit: true")
        fmt = a.get('formatString', '')
        if fmt:
            parts.append(f"note: '格式 {esc(fmt)}'")
        rows.append('  { ' + ', '.join(parts) + ' },')

    footer = ("];\n\n"
              "/** 官方全量 AI 字典，key 为 AI 字符串 */\n"
              "export const GS1_AI_FULL: Record<string, Gs1Ai> = Object.fromEntries(\n"
              "  FULL_AI_LIST.map((a) => [a.ai, a]),\n"
              ");\n")
    out = HEADER + '\n'.join(rows) + '\n' + footer
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(out)
    print(f'generated {len(rows)} AI entries -> {OUT}')


if __name__ == '__main__':
    main()
