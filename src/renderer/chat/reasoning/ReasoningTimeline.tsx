interface ReasoningTimelineProps {
  content: string;
}

export function ReasoningTimeline({ content }: ReasoningTimelineProps): React.JSX.Element {
  const paragraphs = content
    .split('\n\n')
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  return (
    <div className="reasoning-content">
      {paragraphs.map((paragraph, index) => (
        <p key={`${index}-${paragraph.slice(0, 16)}`}>{paragraph}</p>
      ))}
    </div>
  );
}
