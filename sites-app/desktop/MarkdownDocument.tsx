import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownDocument({ body, title }: { body: string; title?: string }) {
  return (
    <div className="desktop-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer">{children}</a>
          ),
          input: (props) => <input {...props} disabled />,
        }}
      >
        {normalizeMarkdown(body, title)}
      </ReactMarkdown>
    </div>
  );
}

export function normalizeMarkdown(body: string, title = "") {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const firstContentIndex = lines.findIndex((line) => line.trim());
  if (firstContentIndex >= 0 && title) {
    const first = lines[firstContentIndex].trim().replace(/^#\s+/, "").trim();
    if (normalizeText(first) === normalizeText(title)) lines.splice(firstContentIndex, 1);
  }
  return lines
    .filter((line) => !/^#{1,6}\s*$/.test(line.trim()))
    .join("\n")
    .trim();
}

function normalizeText(value: string) {
  return value.replace(/[\s！？!?,，。；;：:、]+/g, "").toLocaleLowerCase("zh-CN");
}
