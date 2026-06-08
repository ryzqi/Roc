/**
 * 智能 JSON 渲染器
 *
 * 特性：
 * - 可折叠对象和数组
 * - 语法高亮
 * - 大数组自动折叠
 * - 类型识别
 */

import { useState } from 'react';

type JsonViewProps = {
  data: unknown;
  depth?: number;
};

export function JsonView({ data, depth = 0 }: JsonViewProps): React.JSX.Element {
  if (data === null || data === undefined) {
    return <span className="json-null">null</span>;
  }

  if (typeof data === 'string') {
    return <span className="json-string">"{data}"</span>;
  }

  if (typeof data === 'number') {
    return <span className="json-number">{data}</span>;
  }

  if (typeof data === 'boolean') {
    return <span className="json-boolean">{String(data)}</span>;
  }

  if (Array.isArray(data)) {
    return <JsonArray items={data} depth={depth} />;
  }

  if (typeof data === 'object') {
    return <JsonObject obj={data as Record<string, unknown>} depth={depth} />;
  }

  return <span className="json-unknown">{String(data)}</span>;
}

type JsonObjectProps = {
  obj: Record<string, unknown>;
  depth: number;
};

function JsonObject({ obj, depth }: JsonObjectProps): React.JSX.Element {
  const entries = Object.entries(obj);

  if (entries.length === 0) {
    return <span className="json-empty">{'{}'}</span>;
  }

  return (
    <div className="json-object" style={{ paddingLeft: depth > 0 ? '1.5rem' : '0' }}>
      {entries.map(([key, value]) => (
        <JsonProperty key={key} keyName={key} value={value} depth={depth} />
      ))}
    </div>
  );
}

type JsonPropertyProps = {
  keyName: string;
  value: unknown;
  depth: number;
};

function JsonProperty({ keyName, value, depth }: JsonPropertyProps): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const isExpandable =
    (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0) ||
    (Array.isArray(value) && value.length > 0);

  return (
    <div className="json-property">
      <div className="json-property-key">
        {isExpandable && (
          <button
            className="json-collapse-btn"
            onClick={() => setCollapsed(!collapsed)}
            type="button"
            aria-label={collapsed ? '展开' : '折叠'}
          >
            {collapsed ? '▶' : '▼'}
          </button>
        )}
        <span className="json-key">{keyName}:</span>
      </div>
      {!collapsed && (
        <div className="json-property-value">
          <JsonView data={value} depth={depth + 1} />
        </div>
      )}
      {collapsed && (
        <span className="json-collapsed-hint">
          {Array.isArray(value) ? `[${value.length}]` : '{...}'}
        </span>
      )}
    </div>
  );
}

type JsonArrayProps = {
  items: unknown[];
  depth: number;
};

function JsonArray({ items, depth }: JsonArrayProps): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(items.length > 10);

  if (items.length === 0) {
    return <span className="json-empty">[]</span>;
  }

  return (
    <div className="json-array" style={{ paddingLeft: depth > 0 ? '1rem' : '0' }}>
      <div className="json-array-header">
        <button
          className="json-array-toggle"
          onClick={() => setCollapsed(!collapsed)}
          type="button"
        >
          {collapsed ? '▶' : '▼'} [{items.length} 项]
        </button>
      </div>
      {!collapsed && (
        <div className="json-array-items">
          {items.map((item, index) => (
            <div key={index} className="json-array-item">
              <span className="json-array-index">[{index}]</span>
              <div className="json-array-item-value">
                <JsonView data={item} depth={depth + 1} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
