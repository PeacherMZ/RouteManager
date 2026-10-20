import { useState } from 'react';
import { Button, Combobox, Field, Option } from '@fluentui/react-components';
import { gatewayOptions } from './domain';
import type { RouteSnapshot } from './types';

export interface GatewaySource {
  snapshot: RouteSnapshot | null;
  stale: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}

export function GatewayField({ value, onChange, disabled, snapshot, stale, refreshing, onRefresh }: GatewaySource & {
  value: string; onChange: (value: string) => void; disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const options = gatewayOptions(stale ? [] : snapshot?.routes ?? []);
  const filtered = options.filter(option => option.address.includes(query.trim()));
  return <div className="gateway-field">
    <Field label="网关" required hint={stale ? '路由快照不可用，请刷新后选择，或手动输入。' : '可输入 IPv4 地址，或选择系统已有网关。'}>
      <Combobox freeform open={open} disabled={disabled} value={value} selectedOptions={options.some(option => option.address === value) ? [value] : []}
        placeholder="192.0.2.1" onOpenChange={(_, data) => { setOpen(data.open); if (data.open) setQuery(''); }}
        onKeyDownCapture={event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); } }}
        onChange={event => { setQuery(event.target.value); onChange(event.target.value); }}
        onOptionSelect={(_, data) => { if (data.optionValue) { onChange(data.optionValue); setQuery(''); } }}>
        {filtered.map(option => <Option key={option.address} value={option.address} text={option.address}>
          <span className="gateway-option"><span className="mono">{option.address}{option.address === '0.0.0.0' ? ' · 直连' : ''}</span><small>{option.interfaces.join('、') || '接口未知'}</small></span>
        </Option>)}
        {!filtered.length && <Option disabled text="无可选网关">{stale ? '请先刷新系统路由' : options.length ? '无匹配网关，可继续手动输入' : '系统路由中暂无 IPv4 网关'}</Option>}
      </Combobox>
    </Field>
    <Button size="small" appearance="subtle" disabled={disabled || refreshing} onClick={onRefresh}>{refreshing ? '刷新网关中…' : '刷新网关列表'}</Button>
  </div>;
}
