import { useCallback, useState } from "react";
import { Drawer } from "./components/Drawer";
import { Header } from "./components/Header";
import { ShoppingList } from "./components/ShoppingList";
import { Link, matchRoute, usePath } from "./lib/router";
import { RecipeEditor } from "./pages/RecipeEditor";
import { ImportPage } from "./pages/ImportPage";
import { RecipeHistory } from "./pages/RecipeHistory";
import { RecipeList } from "./pages/RecipeList";
import { RecipeView } from "./pages/RecipeView";
import { ShoppingPage } from "./pages/ShoppingPage";

export function App() {
  const route = matchRoute(usePath());
  const [drawer, setDrawer] = useState(false);
  const close = useCallback(() => setDrawer(false), []);
  return (
    <>
      <Header onOpenShopping={() => setDrawer(true)} />
      {route.name === "list" && <RecipeList />}
      {route.name === "recipe" && <RecipeView key={route.id} id={route.id} />}
      {route.name === "edit" && <RecipeEditor key={`edit-${route.id}`} id={route.id} />}
      {route.name === "history" && <RecipeHistory key={`history-${route.id}`} id={route.id} />}
      {route.name === "new" && <RecipeEditor key={`new-${route.importToken ?? ""}`} importToken={route.importToken} />}
      {route.name === "import" && <ImportPage />}
      {route.name === "shopping" && <ShoppingPage />}
      {route.name === "notFound" && (
        <main className="page">
          <p>
            Not found. <Link href="/">Home</Link>
          </p>
        </main>
      )}
      <Drawer
        open={drawer}
        onClose={close}
        title={
          <Link href="/shopping" onClick={close}>
            Shopping list ↗
          </Link>
        }
      >
        <ShoppingList onNavigate={close} />
      </Drawer>
    </>
  );
}
