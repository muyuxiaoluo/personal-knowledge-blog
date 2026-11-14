import { FINANCE_QUICK_CATEGORIES, FINANCE_QUICK_ROLES, financeQuickCategory, financeQuickRole } from "../app/finance-classification";
import { FINANCE_CATEGORIES, type FinanceBudgetRole, type FinanceCategory } from "../app/finance-types";
import { Button, SelectMenu } from "./DesktopControls";

export function FinanceSpendingFields({ category, budgetRole, onCategory, onRole, showRole = true }: {
  category: FinanceCategory; budgetRole: FinanceBudgetRole;
  onCategory: (value: FinanceCategory) => void; onRole: (value: FinanceBudgetRole) => void; showRole?: boolean;
}) {
  const selectedCategory = financeQuickCategory(category);
  const selectedRole = financeQuickRole(budgetRole);
  return <div className="wealth-spending-fields">
    <fieldset className="wealth-choice-section"><legend>钱花在哪</legend>
      <div className="wealth-category-choices">{FINANCE_QUICK_CATEGORIES.map(group => <Button
        key={group.value} wrap variant={selectedCategory === group ? "primary" : "secondary"} aria-pressed={selectedCategory === group}
        onClick={() => onCategory(selectedCategory === group ? category : group.value)}>
        <span className="wealth-choice-copy"><strong>{group.label}</strong><small>{group.example}</small></span>
      </Button>)}</div>
    </fieldset>
    {selectedCategory.value === "transport" && <div className="wealth-transport-detail"><SelectMenu label="出行分类" value={category} onChange={value => onCategory(value as FinanceCategory)} options={FINANCE_CATEGORIES.filter(item => selectedCategory.members.includes(item.value))} /></div>}
    {showRole && <fieldset className="wealth-choice-section"><legend>这笔开销（可选）</legend>
      <div className="wealth-role-choices">{FINANCE_QUICK_ROLES.map(group => <Button
        key={group.value} wrap variant={selectedRole === group ? "primary" : "secondary"} aria-pressed={selectedRole === group}
        onClick={() => onRole(selectedRole === group ? budgetRole : group.value)}>
        <span className="wealth-choice-copy"><strong>{group.label}</strong><small>{group.example}</small></span>
      </Button>)}</div>
    </fieldset>}
  </div>;
}
