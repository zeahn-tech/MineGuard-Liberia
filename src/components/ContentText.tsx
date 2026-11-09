/** Renders approved content as PLAIN TEXT paragraphs. Content is never interpreted as HTML or
 *  markdown, so nothing an author types can inject markup or scripts. Blank lines separate
 *  paragraphs; single line breaks are kept. */
export function ContentText({ text, className = "" }: { text: string; className?: string }) {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return (
    <div className={`space-y-3 ${className}`}>
      {paragraphs.map((p, i) => (
        <p key={i} className="whitespace-pre-line break-words text-sm leading-relaxed">
          {p}
        </p>
      ))}
    </div>
  );
}
