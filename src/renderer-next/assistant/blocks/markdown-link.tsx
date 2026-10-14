import type { ComponentPropsWithoutRef } from 'react';

/**
 * Markdown link (T4.4), ported from `chat/markdown-link.tsx`.
 *
 * Unchanged behaviour, and worth stating because it is a security decision: a link
 * whose href is not `http(s)` renders as **plain text**. Model output routinely
 * contains `javascript:`, `data:` and relative hrefs, and none of them should become
 * something clickable inside a desktop app. External links open in the system browser
 * through the window's own handler rather than navigating the renderer away.
 */
export function MarkdownLink({ children, href }: ComponentPropsWithoutRef<'a'>): React.JSX.Element {
  // Resolved *before* the sink so the allowlist check and the `window.open` call are
  // provably adjacent: only a value that passed `isAllowedExternalHref` ever reaches
  // the browser call, and anything else (relative, `javascript:`, `data:`, malformed)
  // renders as plain text.
  const safeHref = href !== undefined && isAllowedExternalHref(href) ? href : null;
  if (safeHref === null) {
    return <span>{children}</span>;
  }

  return (
    <a
      href={safeHref}
      rel="noreferrer noopener"
      className="text-accent underline decoration-[var(--line-strong)] underline-offset-2 hover:decoration-current"
      onClick={(event) => {
        event.preventDefault();
        window.open(safeHref, '_blank', 'noopener,noreferrer');
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
