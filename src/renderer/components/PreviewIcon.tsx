import type { PreviewIconName } from '../app/types';

export function PreviewIcon({ name }: { name: PreviewIconName }): React.JSX.Element {
  switch (name) {
    case 'clipboard':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="6" y="5" width="12" height="15" rx="2"></rect>
          <path d="M9 5.5h6"></path>
          <path d="M9 10h6"></path>
          <path d="M9 14h4"></path>
        </svg>
      );
    case 'git':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="6" cy="6" r="2"></circle>
          <circle cx="18" cy="4.5" r="2"></circle>
          <circle cx="18" cy="19.5" r="2"></circle>
          <path d="M7.8 7.2l8.4-1.7"></path>
          <path d="M7.8 7.2l8.4 10.1"></path>
        </svg>
      );
    case 'globe':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9"></circle>
          <path d="M3 12h18"></path>
          <path d="M12 3c2.5 2.4 4 5.6 4 9s-1.5 6.6-4 9c-2.5-2.4-4-5.6-4-9s1.5-6.6 4-9z"></path>
        </svg>
      );
    case 'history':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 12a9 9 0 1 0 3-6.7"></path>
          <path d="M3 4v5h5"></path>
          <path d="M12 7v5l3 2"></path>
        </svg>
      );
    case 'nodes':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="6" cy="6" r="2"></circle>
          <circle cx="18" cy="6" r="2"></circle>
          <circle cx="12" cy="18" r="2"></circle>
          <path d="M7.6 7.2l2.8 8"></path>
          <path d="M16.4 7.2l-2.8 8"></path>
          <path d="M8 6h8"></path>
        </svg>
      );
    case 'paperclip':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8.5 12.5l6.8-6.8a3.2 3.2 0 1 1 4.5 4.5l-9.2 9.2a5 5 0 1 1-7.1-7.1l8.9-8.9"></path>
        </svg>
      );
    case 'panel-right':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2"></rect>
          <path d="M15 4v16"></path>
        </svg>
      );
    case 'bot':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="5" y="7" width="14" height="11" rx="4"></rect>
          <path d="M12 4v3"></path>
          <circle cx="9.5" cy="12" r="1"></circle>
          <circle cx="14.5" cy="12" r="1"></circle>
        </svg>
      );
    case 'eye':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"></path>
          <circle cx="12" cy="12" r="3"></circle>
        </svg>
      );
    case 'send':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 11.5l15-7-4.8 15-2.7-5.1z"></path>
          <path d="M19 4.5L11.4 14.4"></path>
        </svg>
      );
    case 'sparkles':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z"></path>
          <path d="M19 3v4"></path>
          <path d="M21 5h-4"></path>
        </svg>
      );
    case 'stethoscope':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 4v5a4 4 0 0 0 8 0V4"></path>
          <path d="M7 4H5"></path>
          <path d="M17 4h2"></path>
          <path d="M15 13v2a4 4 0 0 0 8 0v-1.5"></path>
          <circle cx="21" cy="12" r="2"></circle>
        </svg>
      );
    case 'terminal':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7l4 4-4 4"></path>
          <path d="M11 17h9"></path>
        </svg>
      );
    case 'wrench':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M14.5 6.5a4 4 0 0 0 3.5 5.8l-8.2 8.2a2 2 0 0 1-2.8-2.8l8.2-8.2a4 4 0 0 0-5.8-3.5l2.2 2.2-2.3 2.3-2.2-2.2a4 4 0 0 1 7.4-1.8z"></path>
        </svg>
      );
    case 'folder':
    default:
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 7.5h5l2 2h11v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
          <path d="M3 7.5V6a2 2 0 0 1 2-2h4l2 2h4"></path>
        </svg>
      );
  }
}
