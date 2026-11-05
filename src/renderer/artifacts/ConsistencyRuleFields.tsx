import {formInputClass} from '../shared/form-ui';

export type ConsistencyRuleFieldsValue = {unit: string; conversion: string; scale: string; offset: string;
  conversionReason: string; rounding: string; places: string; absolute: string; relative: string; toleranceReason: string};
export const emptyConsistencyRuleFields: ConsistencyRuleFieldsValue = {unit: '', conversion: '', scale: '', offset: '',
  conversionReason: '', rounding: '', places: '', absolute: '', relative: '', toleranceReason: ''};
export function ConsistencyRuleFields({fields, onChange}: {fields: ConsistencyRuleFieldsValue;
  onChange: (name: keyof ConsistencyRuleFieldsValue, value: string) => void}): React.JSX.Element {
  const text = (name: keyof ConsistencyRuleFieldsValue, label: string, numeric = false): React.JSX.Element =>
    <label className="flex min-w-0 flex-col gap-1 text-muted">{label}
      <input aria-label={label} type={numeric ? 'number' : 'text'} step={numeric ? 'any' : undefined}
        maxLength={numeric ? undefined : 4000} className={`${formInputClass} border-[0.5px]`}
        value={fields[name]} onChange={event => onChange(name, event.target.value)}/>
    </label>;
  const select = (name: keyof ConsistencyRuleFieldsValue, label: string, options: Record<string, string>): React.JSX.Element =>
    <label className="flex min-w-0 flex-col gap-1 text-muted">{label}
      <select aria-label={label} className={`${formInputClass} border-[0.5px]`} value={fields[name]}
        onChange={event => onChange(name, event.target.value)}>
        <option value="">请选择</option>
        {Object.entries(options).map(([value, valueLabel]) => <option key={value} value={value}>{valueLabel}</option>)}
      </select>
    </label>;
  return <>
    {text('unit', '展示单位')}
    {select('conversion', '单位转换', {identity: '单位相同', affine: '显式比例与偏移'})}
    {fields.conversion !== 'affine' ? null : <>
      {text('scale', '转换比例', true)}{text('offset', '转换偏移', true)}{text('conversionReason', '转换理由')}
    </>}
    {select('rounding', '舍入规则', {none: '不舍入', decimal_places: '十进制位数，半数远离零'})}
    {fields.rounding !== 'decimal_places' ? null : text('places', '小数位数', true)}
    <div className="grid min-w-0 grid-cols-2 gap-3">{text('absolute', '绝对容差', true)}{text('relative', '相对容差', true)}</div>
    {text('toleranceReason', '容差理由')}
  </>;
}
