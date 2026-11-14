import { useCallback, useState } from "react";
import { Drawer } from "./components/Drawer";
import { Header } from "./components/Header";
import { ShoppingList } from "./components/ShoppingList";
import { Link, matchRoute, navigate, usePath } from "./lib/router";
import { ImportPage } from "./pages/ImportPage";
import { RecipeEditor } from "./pages/RecipeEditor";
import { RecipeHistory } from "./pages/RecipeHistory";
import { RecipeList } from "./pages/RecipeList";
import { RecipeView } from "./pages/RecipeView";
import { ShoppingPage } from "./pages/ShoppingPage";

/** Wide enough for the list as a side panel next to the page. Narrower, the cart opens the full page. */
const sidePanel = matchMedia("(min-width: 48rem)");

export function App() {
  const route = matchRoute(usePath());
  const [drawer, setDrawer] = useState(false);
  const close = useCallback(() => setDrawer(false), []);
  return (
    <>
      <Header
        onOpenShopping={() => {
          if (route.name === "shopping") window.scrollTo(0, 0);
          else if (sidePanel.matches) setDrawer(true);
          else navigate("/shopping");
        }}
      />
      {(route.name === "list" || route.name === "bookmarks") && <RecipeList bookmarks={route.name === "bookmarks"} />}
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
