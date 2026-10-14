import React, { useState } from 'react';
import { GripVertical } from 'lucide-react';

interface ResizableDividerProps {
  onDeltaChange: (deltaPx: number) => void;
  onDoubleClickReset?: () => void;
  minReached?: boolean;
  maxReached?: boolean;
  tooltipText?: string;
  badgeLabel?: string;
  className?: string;
  isDragging?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}

export const ResizableDivider: React.FC<ResizableDividerProps> = ({
  onDeltaChange,
  onDoubleClickReset,
  tooltipText,
  badgeLabel,
  className = '',
  isDragging = false,
  onDragStart,
  onDragEnd
}) => {
  const [internalDragging, setInternalDragging] = useState(false);
  const activeDragging = isDragging || internalDragging;

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);

    setInternalDragging(true);
    onDragStart?.();

    let lastX = e.clientX;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - lastX;
      lastX = moveEvent.clientX;
      onDeltaChange(delta);
    };

    const handlePointerUp = (upEvent: PointerEvent) => {
      try {
        target.releasePointerCapture(upEvent.pointerId);
      } catch {
        // Safe fallback
      }
      setInternalDragging(false);
      onDragEnd?.();
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onDoubleClickReset?.();
      }}
      title={tooltipText}
      className={`relative w-2 -mx-1 shrink-0 z-30 cursor-col-resize select-none flex items-center justify-center group touch-none transition-colors ${className}`}
    >
      {/* Visual divider hairline */}
      <div
        className={`w-[1px] h-full transition-colors duration-150 ${
          activeDragging
            ? 'bg-zinc-400 shadow-[0_0_8px_rgba(255,255,255,0.25)]'
            : 'bg-zinc-800 group-hover:bg-zinc-600'
        }`}
      />

      {/* Tactile center grab indicator */}
      <div
        className={`absolute top-1/2 -translate-y-1/2 flex items-center justify-center w-3.5 h-6 rounded-md transition-all duration-150 pointer-events-none ${
          activeDragging
            ? 'bg-zinc-700 text-zinc-100 shadow-sm scale-105 opacity-100'
            : 'bg-zinc-900 border border-zinc-700 text-zinc-400 opacity-0 group-hover:opacity-100 group-hover:scale-100 shadow-xs'
        }`}
      >
        <GripVertical size={10} className="stroke-[2.5]" />
      </div>
    </div>
  );
};
