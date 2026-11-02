// =============================================================================
// VariablesPanel.tsx —— 变量定义面板
// 模板内所有 {{varName}} 占位的变量字典
// =============================================================================

import { useState } from 'react';
import { useDesignerStore } from '../designer/store';
import type { TemplateVariable } from '../designer/types';

export function VariablesPanel() {
  const variables = useDesignerStore((s) => s.template.variables);
  const addVariable = useDesignerStore((s) => s.addVariable);
  const updateVariable = useDesignerStore((s) => s.updateVariable);
  const removeVariable = useDesignerStore((s) => s.removeVariable);

  const [draft, setDraft] = useState<TemplateVariable>({
    name: '', type: 'text', label: '', defaultValue: '', required: false,
  });

  const add = () => {
    if (!draft.name.trim()) return;
    if (variables.some((v) => v.name === draft.name.trim())) {
      alert(`变量 "${draft.name}" 已存在`); return;
    }
    addVariable({ ...draft, name: draft.name.trim(), label: draft.label?.trim() || draft.name.trim() });
    setDraft({ name: '', type: 'text', label: '', defaultValue: '', required: false });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 新增表单 */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#2979ff', marginBottom: 6 }}>新增变量</div>
        <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
          <input style={{ ...inputStyle, flex: 1 }}
            placeholder="变量名（不含空格）"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value.replace(/\s+/g, '_') })}
          />
          <select style={inputStyle} value={draft.type}
            onChange={(e) => setDraft({ ...draft, type: e.target.value as any })}>
            <option value="text">文本</option>
            <option value="number">数字</option>
            <option value="date">日期</option>
            <option value="boolean">布尔</option>
          </select>
        </div>
        <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
          <input style={{ ...inputStyle, flex: 1 }}
            placeholder="显示标签（可选）"
            value={draft.label}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
          <input style={{ ...inputStyle, flex: 1 }}
            placeholder="默认值"
            value={String(draft.defaultValue ?? '')}
            onChange={(e) => setDraft({ ...draft, defaultValue: draft.type === 'number' ? +e.target.value : e.target.value })}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={!!draft.required}
              onChange={(e) => setDraft({ ...draft, required: e.target.checked })} />
            必填
          </label>
          <button onClick={add}
            style={{
              padding: '4px 12px', borderRadius: 3, border: 'none',
              background: '#2979ff', color: '#fff', cursor: 'pointer', fontSize: 12,
              marginLeft: 'auto',
            }}>+ 添加变量</button>
        </div>
      </div>

      {/* 变量列表 */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#2979ff', marginBottom: 6 }}>
          已定义变量 ({variables.length})
        </div>
        {variables.length === 0 && (
          <div style={{ color: '#bbb', fontSize: 11, textAlign: 'center', padding: 16 }}>
            暂无变量，添加后可在元素内容中用 {"{{变量名}}"} 引用
          </div>
        )}
        {variables.map((v) => (
          <div key={v.name} style={{
            display: 'flex', flexDirection: 'column', gap: 4,
            padding: 8, border: '1px solid #e4e4e4', borderRadius: 4,
            marginBottom: 4,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <code style={{
                background: '#eef3ff', color: '#2979ff', padding: '1px 6px',
                borderRadius: 2, fontSize: 11, fontFamily: 'monospace',
              }}>{`{{${v.name}}}`}</code>
              <span style={{ fontSize: 10, color: '#888' }}>
                {v.type}{v.required ? ' · 必填' : ''}
              </span>
              <button onClick={() => removeVariable(v.name)}
                title="删除"
                style={{
                  marginLeft: 'auto', background: 'transparent', border: 'none',
                  cursor: 'pointer', color: '#ff4d4f', fontSize: 14,
                }}>×</button>
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <input style={{ ...inputStyle, flex: 1 }}
                value={v.label ?? ''}
                onChange={(e) => updateVariable(v.name, { label: e.target.value })}
                placeholder="显示标签"
              />
              <input style={{ ...inputStyle, flex: 1 }}
                value={String(v.defaultValue ?? '')}
                onChange={(e) => {
                  const val = v.type === 'number' ? +e.target.value : e.target.value;
                  updateVariable(v.name, { defaultValue: val });
                }}
                placeholder="默认值"
              />
            </div>
          </div>
        ))}
      </div>

      {/* 提示 */}
      <div style={{
        background: '#f9f0ff', border: '1px solid #d3adf7', borderRadius: 4,
        padding: 8, fontSize: 10, color: '#531dab', lineHeight: 1.6,
      }}>
        <b>📖 变量引用规则</b><br />
        • 元素内容里写 <code style={{ background: '#fff', padding: '0 2px', borderRadius: 2 }}>{"{{sku}}"}</code> 打印时自动替换<br />
        • 公式字段可以写 <code style={{ background: '#fff', padding: '0 2px', borderRadius: 2 }}>{"{{price}} * {{qty}} + 1"}</code><br />
        • 批量打印时从 CSV / Excel 列名自动匹配<br />
        • 系统变量: {'{{printDate}}'} {'{{pageNo}}'} {'{{uuid}}'} 等
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  border: '1px solid #d9d9d9', borderRadius: 3, padding: '3px 5px', fontSize: 12,
  outline: 'none', background: '#fff',
};
