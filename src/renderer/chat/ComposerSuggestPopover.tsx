import { useEffect, useRef } from 'react';

import { sanitizeTestId } from '../utils/sanitize-test-id';

export type ComposerSuggestOption = {
  id: string;
  label: string;
  description: string | null;
};

type ComposerSuggestPopoverProps = {
  options: readonly ComposerSuggestOption[];
  activeIndex: number;
  listboxId: string;
  onSelect: (option: ComposerSuggestOption) => void;
  onActiveIndexChange: (index: number) => void;
};

export function composerSuggestOptionDomId(listboxId: string, optionId: string): string {
  return `${listboxId}-${sanitizeTestId(optionId)}`;
}

export function ComposerSuggestPopover({
  options,
  activeIndex,
  listboxId,
  onSelect,
  onActiveIndexChange
}: ComposerSuggestPopoverProps): React.JSX.Element {
  const activeOptionRef = useRef<HTMLButtonElement | null>(null);

  // 列表有 max-height + overflow:auto，键盘上下移动高亮时必须同步滚动，否则高亮项会移出可视区。
  // block: 'nearest' 让已可见的项不产生滚动，鼠标 hover 改变 activeIndex 时不会抖动。
  useEffect(() => {
    activeOptionRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, options]);

  return (
    <div className="composer-popover composer-suggest" data-testid="chat-suggest-popover">
      {/* role=listbox 直接挂在选项容器上：option 必须是 listbox 的直接子元素，中间不能夹无角色的 div。
          焦点始终留在 textarea 上，所以 aria-activedescendant 由 textarea 提供，不在这里。 */}
      <div aria-label="输入补全" className="composer-popover-list" id={listboxId} role="listbox">
        {options.map((option, index) => (
          <button
            aria-selected={index === activeIndex}
            className={index === activeIndex ? 'composer-choice active' : 'composer-choice'}
            data-testid={`chat-suggest-option-${sanitizeTestId(option.id)}`}
            id={composerSuggestOptionDomId(listboxId, option.id)}
            key={option.id}
            ref={index === activeIndex ? activeOptionRef : null}
            role="option"
            type="button"
            onMouseDown={(event) => {
              // 保持 textarea 焦点，避免点击候选时插入位置丢失。
              event.preventDefault();
              onSelect(option);
            }}
            onMouseEnter={() => onActiveIndexChange(index)}
          >
            <span className="composer-choice-copy">
              <span>{option.label}</span>
              {option.description === null ? null : (
                <small className="composer-choice-description composer-choice-description--clamp-2">{option.description}</small>
              )}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
