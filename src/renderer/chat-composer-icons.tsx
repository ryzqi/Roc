import { Bot, FileUp, Sparkles, Wrench } from 'lucide-react';
import type React from 'react';

export type ComposerActionIconKind = 'attachment' | 'tools' | 'skills' | 'model';

export function ComposerActionIcon({ kind }: { kind: ComposerActionIconKind }): React.JSX.Element {
  switch (kind) {
    case 'attachment':
      return <FileUp aria-hidden="true" className="icon-svg" size={16} strokeWidth={1.8} />;
    case 'tools':
      return <Wrench aria-hidden="true" className="icon-svg" size={16} strokeWidth={1.8} />;
    case 'skills':
      return <Sparkles aria-hidden="true" className="icon-svg" size={16} strokeWidth={1.8} />;
    case 'model':
      return <Bot aria-hidden="true" className="icon-svg" size={16} strokeWidth={1.8} />;
  }
}
