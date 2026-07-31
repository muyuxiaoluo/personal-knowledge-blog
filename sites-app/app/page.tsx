import seedArticles from "./generated/articles.json";
import { KnowledgeWorkbench } from "./KnowledgeWorkbench";
import type { Article } from "./types";

export default function Home() {
  return <KnowledgeWorkbench initialArticles={seedArticles as Article[]} />;
}
