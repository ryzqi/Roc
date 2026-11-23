import {useState} from 'react';
import {CheckboxField, FormSection, NumberField, SelectField, TextField} from '../../../src/renderer/shared/form-ui';

/** Permanent examples use the same native controls and tokens as settings. */
export function FormFieldsGallery(): React.JSX.Element {
  const [name, setName] = useState('研究服务');
  const [count, setCount] = useState<number | null | undefined>(4096);
  const [protocol, setProtocol] = useState('openai');
  const [enabled, setEnabled] = useState(true);
  return <main className="mx-auto flex max-w-[960px] flex-col gap-6 p-6" data-testid="fields-gallery">
    <FormSection title="模型与服务" testId="fields-gallery-section">
      <div className="grid min-w-0 grid-cols-2 gap-4" data-testid="fields-gallery-grid">
        <TextField label="供应商名称" value={name} onChange={setName} testId="gallery-text"
          description="用于识别这项服务。" />
        <TextField label="供应商标识" value="research-service" onChange={() => {}} readOnly
          testId="gallery-readonly" description="创建后保持不变，可选择并复制。" />
        <NumberField label="最大 token" value={count} onChange={setCount} min={1} allowEmpty
          description="留空时使用模型默认值。" testId="gallery-number" />
        <SelectField label="连接协议" value={protocol} onChange={setProtocol}
          options={[{value:'openai',label:'OpenAI 兼容'},{value:'anthropic',label:'Anthropic 兼容'}]}
          description="应与供应商支持的协议一致。" testId="gallery-select" />
        <TextField label="接入地址" value="" onChange={() => {}} issue="接入地址不能为空。"
          description="填写服务提供的完整地址。" testId="gallery-error" />
        <TextField label="API Key" type="password" value="fixture-key" onChange={() => {}} disabled
          description="正在保存密钥。" testId="gallery-disabled" />
      </div>
      <CheckboxField label="启用供应商" checked={enabled} onChange={setEnabled}
        description="停用后仍保留配置。" testId="gallery-checkbox" />
    </FormSection>
  </main>;
}
