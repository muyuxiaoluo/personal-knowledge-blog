import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { JSDOM } from "jsdom";
import katex from "katex";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AiMarkdown } from "../desktop/AiMarkdown";
import { isMoreCompleteAiAnswer } from "../app/ai-response-settling";

const adapter = readFileSync(new URL("../src-tauri/src/deepseek.rs", import.meta.url), "utf8");
const serializer = adapter.slice(adapter.indexOf("  const markdownText ="), adapter.indexOf("  const visible ="));
const dom = new JSDOM();
const extract = runInNewContext(`${serializer}; markdownText`, { Node: dom.window.Node });
const parse = (html: string) => {
  const element = dom.window.document.createElement("div");
  element.innerHTML = html;
  return element;
};
const render = (content: string) => parse(renderToStaticMarkup(createElement(AiMarkdown, { children: content })));

test("website matrices and inline math survive extraction and rendering exactly once", () => {
  const matrix = String.raw`x = \begin{bmatrix} p \\ v \end{bmatrix}`;
  const official = parse(`<p>状态：</p>${katex.renderToString(matrix, { displayMode: true })}<p>其中 ${katex.renderToString("p")} 是位置。</p>`);
  const markdown = extract(official);
  assert.match(markdown, /\$\$\n/);
  assert.ok(markdown.includes(matrix));
  const rendered = render(markdown);
  assert.equal(rendered.querySelectorAll(".katex").length, 2);
  assert.equal(rendered.querySelectorAll(".katex-display").length, 1);
  assert.equal(rendered.querySelector("annotation")?.textContent, matrix);
  assert.equal(rendered.querySelectorAll(".katex-error").length, 0);
  assert.equal(isMoreCompleteAiAnswer(extract(official, false), markdown, extract(official, false)), true);
  assert.equal(isMoreCompleteAiAnswer("另一条完整回答", markdown, extract(official, false)), false);
});

test("code, Markdown tables and incomplete streamed formulas remain readable", () => {
  const code = String.raw`$x$ \begin{bmatrix}`;
  const rendered = render("`$x$`\n\n```tex\n" + code + "\n```\n\n| 项目 | 值 |\n| --- | --- |\n| 位置 | $p_k$ |\n\n$$\n\\frac{1}{");
  assert.equal(rendered.querySelector("pre code")?.textContent?.trim(), code);
  assert.equal(rendered.querySelector("p code")?.textContent, "$x$");
  assert.equal(rendered.querySelectorAll("table .katex").length, 1);
  assert.ok(rendered.textContent?.includes("\\frac{1}{"));
});

test("formula commands cannot inject executable markup", () => {
  const rendered = render(String.raw`$\href{javascript:alert(1)}{click}$`);
  assert.equal(rendered.querySelectorAll('a[href^="javascript:"], script').length, 0);
});
