import { useEffect, useState, type ImgHTMLAttributes } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  attachmentIdFromUri,
  type AttachmentRepository,
} from "../app/data/attachment-repository";

type MarkdownDocumentProps = {
  body: string;
  title?: string;
  attachmentRepository?: AttachmentRepository;
  onAttachmentReady?: () => void;
};

export function MarkdownDocument({ body, title, attachmentRepository, onAttachmentReady }: MarkdownDocumentProps) {
  return (
    <div className="desktop-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url, key) => (
          key === "src" && (
            /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,/i.test(url)
            || attachmentIdFromUri(url)
          )
            ? url
            : defaultUrlTransform(url)
        )}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer">{children}</a>
          ),
          input: (props) => <input {...props} disabled />,
          img: (props) => {
            const attachmentId = attachmentIdFromUri(String(props.src || ""));
            return attachmentId && attachmentRepository
              ? <AttachmentImage {...props} attachmentId={attachmentId} repository={attachmentRepository} onReady={onAttachmentReady} />
              : <img {...props} />;
          },
        }}
      >
        {normalizeMarkdown(body, title)}
      </ReactMarkdown>
    </div>
  );
}

const transparentPixel = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

function AttachmentImage({
  attachmentId,
  repository,
  onReady,
  alt,
}: ImgHTMLAttributes<HTMLImageElement> & {
  attachmentId: string;
  repository: AttachmentRepository;
  onReady?: () => void;
}) {
  const [source, setSource] = useState(transparentPixel);
  const [missing, setMissing] = useState(false);
  const [original, setOriginal] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl = "";
    setMissing(false);
    void repository.read(attachmentId, original)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
        onReady?.();
      })
      .catch(() => {
        if (active) setMissing(true);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachmentId, onReady, original, repository]);

  if (missing) {
    return <span className="attachment-missing" role="img" aria-label={alt || "图片缺失"}>图片暂时不可用</span>;
  }
  return (
    <img
      src={source}
      alt={alt || "图片"}
      className="attachment-image"
      data-attachment-id={attachmentId}
      data-attachment-source={`attachment://${attachmentId}`}
      data-original={original ? "true" : "false"}
      title={original ? "正在显示原图" : "点击加载原图"}
      onClick={() => setOriginal(true)}
    />
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
