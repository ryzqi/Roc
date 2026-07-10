import type { ComponentPropsWithoutRef } from 'react';

export function MarkdownLink({ children, href }: ComponentPropsWithoutRef<'a'>): React.JSX.Element {
  if (href === undefined || !isAllowedExternalHref(href)) {
    return <span>{children}</span>;
  }

  return (
    <a
      href={href}
      rel="noreferrer noopener"
      onClick={(event) => {
        event.preventDefault();
        window.open(href, '_blank', 'noopener,noreferrer');
      }}
    >
      {children}
    </a>
  );
}

function isAllowedExternalHref(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
