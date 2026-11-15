use super::{update, Job};
use quick_xml::{
    events::{BytesStart, Event},
    Reader,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::File,
    io::Read,
    path::Path,
};

const MAX_XML: u64 = 16 * 1024 * 1024;
const MAX_FINDINGS: usize = 250;
type Properties = BTreeMap<String, String>;

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Document {
    thesis: String,
    template: String,
}

impl Document {
    pub(super) fn title(&self) -> String {
        format!(
            "论文格式 · {}",
            Path::new(&self.thesis)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
        )
    }
}

pub(super) fn validate(input: &Document) -> Result<(), String> {
    for path in [&input.thesis, &input.template] {
        let path = Path::new(path);
        if !path.is_absolute()
            || !path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("docx"))
        {
            return Err("请选择本机 Word .docx 论文和模板。".into());
        }
    }
    if input.thesis == input.template {
        return Err("请选择不同的论文与模板文件。".into());
    }
    Ok(())
}

pub(super) async fn run(app: &tauri::AppHandle, job: &Job) -> Result<Value, String> {
    let input = job.document.clone().ok_or("缺少待检查文件")?;
    update(app, &job.id, |job| {
        job.progress = Some("在本机读取论文与模板".into())
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        let thesis = read_doc(&input.thesis, "论文")?;
        let template = read_doc(&input.template, "模板")?;
        Ok(compare(&thesis, &template))
    })
    .await
    .map_err(|_| "论文格式检查意外中止。".to_owned())?
}

#[derive(Default)]
struct Node {
    name: String,
    attrs: Properties,
    children: Vec<Node>,
    text: String,
}

impl Node {
    fn child(&self, name: &str) -> Option<&Self> {
        self.children.iter().find(|n| n.name == name)
    }
    fn children<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Self> {
        self.children.iter().filter(move |n| n.name == name)
    }
    fn attr(&self, key: &str) -> Option<&str> {
        self.attrs.get(key).map(String::as_str)
    }
    fn value(&self, child: &str) -> Option<&str> {
        self.child(child)?.attr("val")
    }
}

fn xml_node(reader: &Reader<&[u8]>, tag: &BytesStart<'_>) -> Result<Node, String> {
    let mut node = Node {
        name: String::from_utf8_lossy(tag.local_name().as_ref()).into(),
        ..Node::default()
    };
    for attr in tag.attributes() {
        let attr = attr.map_err(|_| "Word XML 属性无效")?;
        let key = String::from_utf8_lossy(attr.key.local_name().as_ref()).into_owned();
        let value = attr
            .decode_and_unescape_value(reader.decoder())
            .map_err(|_| "Word XML 属性无效")?;
        node.attrs.insert(key, value.into_owned());
    }
    Ok(node)
}

fn parse_xml(bytes: &[u8]) -> Result<Node, String> {
    let mut reader = Reader::from_reader(bytes);
    let mut stack = vec![Node::default()];
    loop {
        match reader.read_event().map_err(|_| "无法解析 Word XML")? {
            Event::Start(tag) if stack.len() < 128 => stack.push(xml_node(&reader, &tag)?),
            Event::Start(_) | Event::DocType(_) => return Err("Word XML 结构超出检查范围".into()),
            Event::Empty(tag) => stack
                .last_mut()
                .unwrap()
                .children
                .push(xml_node(&reader, &tag)?),
            Event::End(_) if stack.len() > 1 => {
                let node = stack.pop().unwrap();
                stack.last_mut().unwrap().children.push(node);
            }
            Event::Text(value) => stack
                .last_mut()
                .unwrap()
                .text
                .push_str(&value.decode().map_err(|_| "Word XML 文字无效")?),
            Event::GeneralRef(value) => {
                let reference = value.decode().map_err(|_| "Word XML 引用无效")?;
                let escaped = format!("&{reference};");
                let decoded =
                    quick_xml::escape::unescape(&escaped).map_err(|_| "Word XML 引用无效")?;
                stack.last_mut().unwrap().text.push_str(&decoded);
            }
            Event::Eof if stack.len() == 1 => {
                return stack
                    .pop()
                    .unwrap()
                    .children
                    .into_iter()
                    .next()
                    .ok_or("Word XML 内容为空".into())
            }
            Event::Eof => return Err("Word XML 内容不完整".into()),
            _ => {}
        }
    }
}

struct Word {
    body: Node,
    styles: Node,
}

fn read_doc(path: &str, label: &str) -> Result<Word, String> {
    let read = || -> Result<Word, String> {
        let file = File::open(path).map_err(|_| "文件不可读取")?;
        let mut zip = zip::ZipArchive::new(file).map_err(|_| "文件不是有效或可读取的 DOCX")?;
        let mut read_part = |name: &str| -> Result<Option<Node>, String> {
            let file = match zip.by_name(name) {
                Ok(file) => file,
                Err(zip::result::ZipError::FileNotFound) => return Ok(None),
                Err(_) => return Err("无法读取 Word 文件部件".into()),
            };
            let mut bytes = Vec::new();
            file.take(MAX_XML + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "无法读取 Word 文件部件")?;
            if bytes.len() as u64 > MAX_XML {
                return Err("Word 文件部件超过 16 MiB".into());
            }
            parse_xml(&bytes).map(Some)
        };
        let document = read_part("word/document.xml")?.ok_or("缺少 Word 正文")?;
        let body = document
            .children
            .into_iter()
            .find(|part| part.name == "body")
            .ok_or("缺少 Word 正文")?;
        let styles = read_part("word/styles.xml")?.unwrap_or_default();
        Ok(Word { body, styles })
    };
    read().map_err(|error| format!("{label}：{error}"))
}

fn merge_props(target: &mut Properties, node: Option<&Node>, keys: &[&str]) {
    let Some(node) = node else { return };
    for field in &node.children {
        if !keys.contains(&field.name.as_str()) {
            continue;
        }
        for (key, value) in &field.attrs {
            target.insert(format!("{}.{}", field.name, key), value.clone());
        }
    }
}

const PARAGRAPH: &[&str] = &["jc", "ind", "spacing", "outlineLvl"];
const RUN: &[&str] = &["rFonts", "sz", "szCs"];

impl Word {
    fn default_style(&self) -> &str {
        self.styles
            .children("style")
            .find(|style| {
                style.attr("type") == Some("paragraph")
                    && matches!(style.attr("default"), Some("1" | "true"))
            })
            .and_then(|style| style.attr("styleId"))
            .unwrap_or("Normal")
    }

    fn style(&self, id: &str) -> Option<&Node> {
        self.styles
            .children("style")
            .find(|style| style.attr("styleId") == Some(id))
    }

    fn inherit(&self, id: &str, seen: &mut HashSet<String>, apply: &mut impl FnMut(&Node)) {
        if seen.len() >= 32 || !seen.insert(id.to_owned()) {
            return;
        }
        if let Some(style) = self.style(id) {
            if let Some(parent) = style.value("basedOn") {
                self.inherit(parent, seen, apply);
            }
            apply(style);
        }
    }

    fn props(&self, paragraph: &Node) -> (String, Properties, Properties) {
        let properties = paragraph.child("pPr");
        let id = properties
            .and_then(|value| value.value("pStyle"))
            .unwrap_or_else(|| self.default_style());
        let mut para = Properties::new();
        let mut run = Properties::new();
        if let Some(defaults) = self.styles.child("docDefaults") {
            merge_props(
                &mut para,
                defaults
                    .child("pPrDefault")
                    .and_then(|node| node.child("pPr")),
                PARAGRAPH,
            );
            merge_props(
                &mut run,
                defaults
                    .child("rPrDefault")
                    .and_then(|node| node.child("rPr")),
                RUN,
            );
        }
        self.inherit(id, &mut HashSet::new(), &mut |style| {
            merge_props(&mut para, style.child("pPr"), PARAGRAPH);
            merge_props(&mut run, style.child("rPr"), RUN);
        });
        merge_props(&mut para, properties, PARAGRAPH);
        let style_name = self
            .style(id)
            .and_then(|style| style.value("name"))
            .unwrap_or(id);
        let role = if let Some(level) = para
            .get("outlineLvl.val")
            .and_then(|s| s.parse::<u8>().ok())
            .filter(|n| *n < 9)
        {
            format!("heading:{}", level + 1)
        } else if let Some(level) = heading_level(style_name).or_else(|| heading_level(id)) {
            format!("heading:{level}")
        } else if id == self.default_style()
            || matches!(
                style_name.to_lowercase().as_str(),
                "normal" | "body text" | "正文"
            )
        {
            "body".into()
        } else {
            style_name.to_lowercase()
        };
        (role, para, run)
    }

    fn runs(&self, para: &Node, base: &Properties) -> Vec<Properties> {
        fn collect<'a>(node: &'a Node, runs: &mut Vec<&'a Node>) {
            for child in &node.children {
                if child.name == "r" && child.children("t").any(|t| !t.text.trim().is_empty()) {
                    runs.push(child);
                } else if matches!(
                    child.name.as_str(),
                    "hyperlink" | "ins" | "sdt" | "sdtContent"
                ) {
                    collect(child, runs);
                }
            }
        }
        let mut runs = Vec::new();
        collect(para, &mut runs);
        runs.into_iter()
            .map(|node| {
                let mut properties = base.clone();
                let local = node.child("rPr");
                if let Some(id) = local.and_then(|node| node.value("rStyle")) {
                    self.inherit(id, &mut HashSet::new(), &mut |style| {
                        merge_props(&mut properties, style.child("rPr"), RUN)
                    });
                }
                merge_props(&mut properties, local, RUN);
                properties
            })
            .collect()
    }
}

fn heading_level(name: &str) -> Option<u8> {
    let name = name.to_lowercase();
    let number = name
        .strip_prefix("heading")
        .or_else(|| name.strip_prefix("标题"))?;
    number.trim().parse().ok().filter(|n| (1..=9).contains(n))
}

fn paragraph_text(node: &Node) -> String {
    if node.name == "t" {
        return node.text.clone();
    }
    node.children
        .iter()
        .filter(|n| n.name != "pPr")
        .map(paragraph_text)
        .collect()
}

#[derive(Serialize)]
struct Issue {
    location: String,
    property: String,
    actual: String,
    expected: String,
}

#[derive(Default)]
struct Report {
    issues: Vec<Issue>,
    manual: Vec<String>,
    omitted: usize,
    checked: usize,
}

impl Report {
    fn compare(
        &mut self,
        location: &str,
        actual: &Properties,
        expected: &[&Properties],
        fields: &[(&str, &str)],
    ) {
        for &(key, label) in fields {
            let Some(target) = expected.first().and_then(|properties| properties.get(key)) else {
                continue;
            };
            if !expected
                .iter()
                .all(|properties| properties.get(key) == Some(target))
            {
                continue;
            }
            self.checked += 1;
            let current = actual.get(key).map(String::as_str).unwrap_or("未声明");
            if current == target {
                continue;
            }
            if self.issues.len() >= MAX_FINDINGS {
                self.omitted += 1;
                continue;
            }
            self.issues.push(Issue {
                location: location.into(),
                property: label.into(),
                actual: display_value(key, current),
                expected: display_value(key, target),
            });
        }
    }

    fn manual(&mut self, message: String) {
        if self.manual.len() < 50 && !self.manual.contains(&message) {
            self.manual.push(message);
        }
    }
}

fn display_value(key: &str, value: &str) -> String {
    if let Ok(number) = value.parse::<f64>() {
        if key.starts_with("sz") {
            return format!("{} pt", number / 2.0);
        }
        if key.starts_with("pgMar.") {
            return format!("{:.2} cm", number / 1440.0 * 2.54);
        }
    }
    value.into()
}

const PARA_FIELDS: &[(&str, &str)] = &[
    ("outlineLvl.val", "标题层级（从 0 开始）"),
    ("jc.val", "对齐"),
    ("ind.left", "左缩进"),
    ("ind.right", "右缩进"),
    ("ind.firstLine", "首行缩进"),
    ("ind.hanging", "悬挂缩进"),
    ("ind.firstLineChars", "首行缩进（字符）"),
    ("spacing.before", "段前"),
    ("spacing.after", "段后"),
    ("spacing.line", "行距"),
    ("spacing.lineRule", "行距规则"),
];
const RUN_FIELDS: &[(&str, &str)] = &[
    ("rFonts.ascii", "西文字体"),
    ("rFonts.hAnsi", "西文字体（高位）"),
    ("rFonts.eastAsia", "东亚字体"),
    ("sz.val", "字号"),
];
const MARGINS: &[(&str, &str)] = &[
    ("pgMar.top", "上页边距"),
    ("pgMar.bottom", "下页边距"),
    ("pgMar.left", "左页边距"),
    ("pgMar.right", "右页边距"),
];

#[derive(Default)]
struct TemplateStyle {
    para: Properties,
    run: Properties,
    seen: bool,
    ambiguous: bool,
}

fn merge_consensus(consensus: &mut Properties, sample: &Properties) -> bool {
    let count = consensus.len();
    let same = consensus == sample;
    if !same {
        consensus.retain(|key, value| sample.get(key) == Some(value));
    }
    !same || consensus.len() != count
}

fn template_styles(
    template: &Word,
    paragraphs: impl IntoIterator<Item = impl std::borrow::Borrow<Node>>,
) -> HashMap<String, TemplateStyle> {
    let mut styles = HashMap::<String, TemplateStyle>::new();
    for paragraph in paragraphs {
        let paragraph = paragraph.borrow();
        if paragraph_text(paragraph).trim().is_empty() {
            continue;
        }
        let (role, para, run) = template.props(paragraph);
        let style = styles.entry(role).or_default();
        let mut runs = template.runs(paragraph, &run).into_iter();
        let mut run = runs.next().unwrap_or_default();
        let mut ambiguous = false;
        for sample in runs {
            ambiguous |= merge_consensus(&mut run, &sample);
        }
        if style.seen {
            style.ambiguous |= merge_consensus(&mut style.para, &para);
            style.ambiguous |= merge_consensus(&mut style.run, &run);
        } else {
            style.para = para;
            style.run = run;
            style.seen = true;
        }
        style.ambiguous |= ambiguous;
    }
    styles
}

fn compare_paragraph(
    report: &mut Report,
    thesis: &Word,
    current: &Node,
    samples: &HashMap<String, TemplateStyle>,
    location: &str,
) {
    if paragraph_text(current).trim().is_empty() {
        return;
    }
    let (role, actual_para, actual_run) = thesis.props(current);
    let Some(style) = samples.get(&role) else {
        report.manual(format!("{location}：模板没有明确对应的段落样式。"));
        return;
    };
    let before = report.checked;
    report.compare(location, &actual_para, &[&style.para], PARA_FIELDS);
    let actual_runs = thesis.runs(current, &actual_run);
    let mut distinct = HashSet::new();
    for (index, run) in actual_runs.iter().enumerate() {
        if distinct.insert(run) {
            report.compare(
                &format!("{location} · 文本片段 {}", index + 1),
                run,
                &[&style.run],
                RUN_FIELDS,
            );
        }
    }
    if before == report.checked || style.ambiguous {
        report.manual(format!("{location}：模板部分属性没有一致的可测值。"));
    }
}

fn section_margins(body: &Node) -> Vec<Properties> {
    body.children
        .iter()
        .filter_map(|entry| {
            let section = if entry.name == "sectPr" {
                entry
            } else {
                entry.child("pPr")?.child("sectPr")?
            };
            let mut properties = Properties::new();
            merge_props(&mut properties, Some(section), &["pgMar"]);
            Some(properties)
        })
        .collect()
}

fn table_style<'a>(word: &'a Word, table: &'a Node) -> Option<&'a str> {
    let id = table.child("tblPr")?.value("tblStyle")?;
    Some(
        word.style(id)
            .and_then(|style| style.value("name"))
            .unwrap_or(id),
    )
}

fn table_borders(word: &Word, table: &Node) -> Properties {
    let mut result = Properties::new();
    let properties = table.child("tblPr");
    let mut apply = |borders: Option<&Node>| {
        merge_props(
            &mut result,
            borders,
            &[
                "top", "bottom", "left", "right", "start", "end", "insideH", "insideV",
            ],
        )
    };
    if let Some(id) = properties.and_then(|node| node.value("tblStyle")) {
        word.inherit(id, &mut HashSet::new(), &mut |style| {
            apply(
                style
                    .child("tblPr")
                    .and_then(|node| node.child("tblBorders")),
            )
        });
    }
    apply(properties.and_then(|node| node.child("tblBorders")));
    result
}

fn compare(thesis: &Word, template: &Word) -> Value {
    let mut report = Report::default();
    let samples = template_styles(template, template.body.children("p"));
    let mut section_name = "正文".to_owned();
    for (index, paragraph) in thesis.body.children("p").enumerate() {
        if thesis.props(paragraph).0.starts_with("heading:") {
            section_name = format!("标题段落 {}", index + 1);
        }
        compare_paragraph(
            &mut report,
            thesis,
            paragraph,
            &samples,
            &format!("{section_name} · 正文段落 {}", index + 1),
        );
    }
    let actual_sections = section_margins(&thesis.body);
    let expected_sections = section_margins(&template.body);
    for (index, margins) in actual_sections.iter().enumerate() {
        let expected = if expected_sections.len() == actual_sections.len() {
            expected_sections.get(index)
        } else {
            expected_sections
                .first()
                .filter(|first| expected_sections.iter().all(|value| value == *first))
        };
        if let Some(expected) = expected.filter(|value| !value.is_empty()) {
            report.compare(
                &format!("第 {} 节", index + 1),
                margins,
                &[expected],
                MARGINS,
            );
        } else {
            report.manual(format!("第 {} 节：模板页边距无法明确对应。", index + 1));
        }
    }
    if actual_sections.is_empty() {
        report.manual("论文没有可读取的分节页边距。".into());
    }
    for (index, table) in thesis.body.children("tbl").enumerate() {
        let label = format!("表格 {}", index + 1);
        let style = table_style(thesis, table);
        let mut candidates = template
            .body
            .children("tbl")
            .filter(|sample| style.is_some() && table_style(template, sample) == style);
        let Some(sample) = candidates.next().filter(|_| candidates.next().is_none()) else {
            report.manual(format!("{label}：模板没有唯一匹配的表格样式。"));
            continue;
        };
        let actual = table_borders(thesis, table);
        let expected = table_borders(template, sample);
        for key in expected.keys() {
            report.compare(
                &label,
                &actual,
                &[&expected],
                &[(key.as_str(), &format!("边框 {key}"))],
            );
        }
        let reference_rows: Vec<_> = sample.children("tr").collect();
        for (row_index, row) in table.children("tr").enumerate() {
            for (column_index, cell) in row.children("tc").enumerate() {
                let place = format!(
                    "{label} · 第 {} 行第 {} 列",
                    row_index + 1,
                    column_index + 1
                );
                let Some(reference) = reference_rows
                    .get(row_index)
                    .and_then(|row| row.children("tc").nth(column_index))
                else {
                    report.manual(format!("{place}：模板无对应单元格。"));
                    continue;
                };
                let cell_samples = template_styles(template, reference.children("p"));
                for (para_index, paragraph) in cell.children("p").enumerate() {
                    compare_paragraph(
                        &mut report,
                        thesis,
                        paragraph,
                        &cell_samples,
                        &format!("{place} · 段落 {}", para_index + 1),
                    );
                }
            }
        }
    }
    report.manual("最终分页、页码、目录、主题字体替代及复杂表格条件样式需在 Word 中确认。".into());
    json!({"issues":report.issues,"manual":report.manual,"omitted":report.omitted,"checked":report.checked,
        "nextAction": if report.issues.is_empty() { "" } else { "核对论文格式检查中列出的差异，优先处理标题和正文样式" }})
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn compares_docx_style_inheritance_run_override_margins_and_tables_without_writing_input() {
        let folder = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&folder).unwrap();
        let styles = r#"<styles><style styleId="Normal" type="paragraph" default="1"><rPr><rFonts ascii="Times New Roman" eastAsia="宋体"/><sz val="24"/></rPr></style><style styleId="Heading1" type="paragraph"><basedOn val="Normal"/><pPr><outlineLvl val="0"/></pPr></style><style styleId="TableGrid" type="table"><name val="Table Grid"/></style></styles>"#;
        let write = |filename: &str, size: &str, margin: &str, border: &str| {
            let path = folder.join(filename);
            let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("word/styles.xml", options).unwrap();
            zip.write_all(styles.as_bytes()).unwrap();
            zip.start_file("word/document.xml", options).unwrap();
            write!(zip, r#"<document><body><p><pPr><pStyle val="Heading1"/></pPr><r><rPr>{size}</rPr><t>第一章</t></r></p><tbl><tblPr><tblStyle val="TableGrid"/><tblBorders><top val="{border}"/></tblBorders></tblPr><tr><tc><p><r><t>模板示例</t></r></p></tc></tr></tbl><sectPr><pgMar top="{margin}"/></sectPr></body></document>"#).unwrap();
            zip.finish().unwrap();
            path
        };
        let thesis = write("paper.docx", r#"<sz val="28"/>"#, "720", "double");
        let template = write("template.docx", "", "1440", "single");
        let original = std::fs::read(&thesis).unwrap();
        let report = compare(
            &read_doc(thesis.to_str().unwrap(), "论文").unwrap(),
            &read_doc(template.to_str().unwrap(), "模板").unwrap(),
        );
        let issues = report["issues"].as_array().unwrap();
        assert_eq!(issues.len(), 3);
        assert!(issues.iter().any(|item| item["property"] == "字号"
            && item["actual"] == "14 pt"
            && item["expected"] == "12 pt"));
        assert!(issues
            .iter()
            .any(|item| item["location"] == "第 1 节" && item["property"] == "上页边距"));
        assert!(issues
            .iter()
            .any(|item| item["location"] == "表格 1" && item["expected"] == "single"));
        assert_eq!(original, std::fs::read(&thesis).unwrap());
        std::fs::remove_file(thesis).unwrap();
        std::fs::remove_file(template).unwrap();
        std::fs::remove_dir(folder).unwrap();
    }
}
