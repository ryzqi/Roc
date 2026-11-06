import {formInputClass, formTextAreaClass} from '../shared/form-ui';

export type ExportLicenseDraft = {name: string; description: string; url: string};
export type ExportMetadataDraft = {
  name: string; description: string; version: string; url: string; license: ExportLicenseDraft
};
export const emptyExportLicense = (): ExportLicenseDraft => ({name: '', description: '', url: ''});
export const emptyExportMetadata = (): ExportMetadataDraft =>
  ({name: '', description: '', version: '', url: '', license: emptyExportLicense()});
export const exportOptionalText = (value: string): string | null => value.trim() === '' ? null : value.trim();
export const exportLicenseInput = (value: ExportLicenseDraft) => ({...value, url: exportOptionalText(value.url)});
export const exportMetadataInput = (value: ExportMetadataDraft) =>
  ({name: value.name, description: value.description, version: exportOptionalText(value.version),
    url: exportOptionalText(value.url), license: exportLicenseInput(value.license)});

export function ExportTextField({label, value, onChange, multiline = false, type = 'text'}: {
  label: string; value: string; onChange: (value: string) => void; multiline?: boolean; type?: 'text' | 'date'
}): React.JSX.Element {
  return <label className="flex min-w-0 flex-col gap-1 text-muted">{label}
    {multiline ? <textarea className={`${formTextAreaClass} border-[0.5px] font-sans`} value={value}
      onChange={event => onChange(event.target.value)}/> :
      <input className={`${formInputClass} border-[0.5px]`} type={type} value={value}
        onChange={event => onChange(event.target.value)}/>}
  </label>;
}

export function ExportLicenseFields({value, onChange}: {
  value: ExportLicenseDraft; onChange: (value: ExportLicenseDraft) => void
}): React.JSX.Element {
  return <div className="flex min-w-0 flex-col gap-2">
    <ExportTextField label="许可名称" value={value.name} onChange={name => onChange({...value, name})}/>
    <ExportTextField label="许可及权限说明" value={value.description} multiline onChange={description => onChange({...value, description})}/>
    <ExportTextField label="许可 URL（可留空）" value={value.url} onChange={url => onChange({...value, url})}/>
  </div>;
}

export function ExportMetadataFields({value, onChange}: {
  value: ExportMetadataDraft; onChange: (value: ExportMetadataDraft) => void
}): React.JSX.Element {
  return <div className="flex min-w-0 flex-col gap-2">
    <ExportTextField label="名称" value={value.name} onChange={name => onChange({...value, name})}/>
    <ExportTextField label="说明" multiline value={value.description} onChange={description => onChange({...value, description})}/>
    <ExportTextField label="版本（软件必填）" value={value.version} onChange={version => onChange({...value, version})}/>
    <ExportTextField label="公开 URL（软件必填）" value={value.url} onChange={url => onChange({...value, url})}/>
    <ExportLicenseFields value={value.license} onChange={license => onChange({...value, license})}/>
  </div>;
}
