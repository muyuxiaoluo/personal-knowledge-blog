import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = path.join(projectRoot, "desktop");
const legacyButtonVariants = new Set(["primary", "secondary", "quiet", "ghost", "danger"]);
const violations = [];
const pageStyleLayers = {
  "dashboard.css": "dashboard", "ai-tools.css": "ai", "project-refinements.css": "project",
  "capture.css": "capture", "health.css": "health", "wealth.css": "wealth",
  "notes-final.css": "notes", "avatar-settings.css": "avatar",
};
const isUnregisteredStyle = (value) => /\/styles\/.*\.css$/.test(value) && !pageStyleLayers[path.basename(value)];

// Parse JSX rather than matching tag text: handlers may contain `>` and multiline expressions.
export function inspectComponent(source, relative) {
  const issues = [];
  const tree = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function report(node, message) { issues.push(`${relative}:${lineAt(source, node.getStart(tree))} ${message}`); }
  function hasMarkup(node) {
    return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)
      || Boolean(ts.forEachChild(node, (child) => hasMarkup(child) || undefined));
  }
  function visitNode(node) {
    if (ts.isImportDeclaration(node) && isUnregisteredStyle(node.moduleSpecifier.text)) {
      report(node, "公共样式应在 desktop.css 注册；页面样式需有独立的已登记子层。");
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.some((argument) => ts.isStringLiteral(argument) && isUnregisteredStyle(argument.text))) {
      report(node, "不得按页面动态加载公共样式；请在 desktop.css 注册。");
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(tree);
      if (tag === "select") report(node, "请复用 SelectMenu。");
      if (tag === "button" && !relative.endsWith("/DesktopControls.tsx")) {
        const classAttribute = node.attributes.properties.find((attribute) => attribute.name?.getText(tree) === "className");
        const value = classAttribute?.initializer;
        if (value && ts.isStringLiteral(value) && value.text.split(/\s+/).some((token) => legacyButtonVariants.has(token))) {
          report(node, "语义操作请使用 Button variant，不要使用旧按钮类名。");
        }
        const structured = ts.isJsxElement(node.parent) && node.parent.children.some(hasMarkup);
        if (!classAttribute && !structured) report(node, "普通操作按钮缺少统一外观；请使用 Button（图标操作可使用 iconOnly）。");
        if (ts.isJsxElement(node.parent) && !structured && value && ts.isStringLiteral(value)
          && value.text !== "sidebar-collapse-toggle" && !value.text.split(/\s+/).some((token) => legacyButtonVariants.has(token))) {
          report(node, "带自定义类名的普通操作也必须复用 Button，避免形成另一套按钮外观。");
        }
      }
    }
    ts.forEachChild(node, visitNode);
  }
  visitNode(tree);
  return issues;
}

export function inspectStyleEntry(source) {
  const issues = [];
  if (!/@layer\s+pages,\s*visual,\s*controls\s*;/.test(source)) issues.push("样式层必须按 pages、visual、controls 排序，确保公共控件不被页面覆盖。");
  for (const match of source.matchAll(/@import\s+"([^\"]+)"([^;]*);/g)) {
    const expected = match[1].endsWith("/controls.css") ? "controls" : match[1].endsWith("/visual-system.css") ? "visual" : "pages";
    const nested = expected === "pages" && /layer\(pages\.[\w-]+\)/.test(match[2]);
    const registered = pageStyleLayers[path.basename(match[1])] && !match[2].trim();
    if (!registered && !nested && !match[2].includes(`layer(${expected})`)) issues.push(`${match[1]} 必须加载到 ${expected} 层。`);
  }
  return issues;
}

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(target);
      continue;
    }
    if (!entry.name.endsWith(".tsx")) continue;
    const source = await readFile(target, "utf8");
    const relative = path.relative(projectRoot, target).replaceAll(path.sep, "/");

    violations.push(...inspectComponent(source, relative));
  }
}

function lineAt(source, index) {
  return source.slice(0, index).split("\n").length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await visit(desktopRoot);
  const desktopEntry = await readFile(path.join(desktopRoot, "desktop.css"), "utf8");
  for (const [file, layer] of Object.entries(pageStyleLayers)) {
    const source = await readFile(path.join(desktopRoot, "styles", file), "utf8");
    if (!source.trim().startsWith(`@layer pages.${layer} {`) || !desktopEntry.includes(`pages.${layer}`)) {
      violations.push(`${file}: 页面样式必须包在已登记的 pages.${layer} 子层内。`);
    }
  }
  for (const entry of ["desktop.css", "capture-entry.css"]) {
    violations.push(...inspectStyleEntry(await readFile(path.join(desktopRoot, entry), "utf8")).map((issue) => `${entry}: ${issue}`));
  }
  if (violations.length) {
    console.error(["UI primitive check failed:", ...violations.map((item) => `- ${item}`)].join("\n"));
    process.exitCode = 1;
  } else {
    console.log("UI check passed: shared actions, centralized styles and protected control layer.");
  }
}
