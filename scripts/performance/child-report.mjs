import {existsSync, readFileSync} from 'node:fs';

/** Preserve malformed output before callers remove their temporary reports. */
export function readChildReport(path) {
  if (!existsSync(path)) return {report: null};
  let content;
  try {
    content = readFileSync(path, 'utf8');
    return {report: JSON.parse(content)};
  } catch (error) {
    return {report: null, reportReadError: String(error),
      ...(content === undefined ? {} : {unparsedReport: content})};
  }
}
