import { ShoppingList } from "../components/ShoppingList";
import { Link } from "../lib/router";

export function ShoppingPage() {
  return (
    <main className="page shopping-page">
      <div className="page-title">
        <h1>Shopping list</h1>
        <Link href="/">← Recipes</Link>
      </div>
      <ShoppingList />
    </main>
  );
}
